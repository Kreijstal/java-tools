'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame');
const {newFields,makeObjectRef,writeField}=require('../src/core/objectModel');
const {getOp,takeWasmReturnValue}=require('../src/jit/wasmShared');
const {allocMultiArray}=require('../src/instructions/object');
const compile=require('./javaFixture').makeJavaFixtureCompiler('native-array-return-owner-');

test('array returns lend only private ownership to the actual returned value',async t=>{
 const classpath=compile(t,'ReturnOwnership',`
 class OwnedRows {int[][] rows;int[] direct;
  int[] row(int i){return rows[i];}
  int[] field(){return direct;}
  int[] twoFields(){int[] result=direct;int unused=rows[0][0];return result;}
  int[] relay(int i){return row(i);}
  int[] recursive(int i,int n){return n==0?row(i):recursive(i,n-1);}
  int[] select(boolean first,int[] other){return first?rows[0]:other;}
 }
 class RowState {int[] input;int a,b,c,d;}
 public class ReturnOwnership {
  static int touch(RowState s,int n){for(int i=0;i<n;i++){s.a++;s.b++;s.c++;s.d++;s.a+=s.input[0];}return s.a;}
  static int scan(OwnedRows book,RowState s,int n){int sum=0;for(int i=0;i<n;i++){int[] a=book.row(i&1);for(int k=0;k<2;k++){sum+=touch(s,0);sum+=a[k];}}return sum;}
  static int relay(OwnedRows book){return book.relay(1)[1];}
  static int recursive(OwnedRows book){return book.recursive(1,4)[1];}
 }`);
 const makeVm=async()=>{const j=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:true,
  wasm:{deepInline:false,maxInlineCalleeItems:1,inlineBudget:1,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
  await j.preloadClasspathClasses();for(const name of ['OwnedRows','RowState','ReturnOwnership'])j._markClassInitialized(name);return j;};
 const j=await makeVm(),w=j.jit.wasmJit;w.importStatsEnabled=true;
 const build=(owner,name,descriptor)=>{const method=j.findMethod(j.classes[owner],name,descriptor),state=w.methodState({method});w.compile({method,className:owner},state,{asCallee:true});
  t.equal(state.status,'ready',state.lastCompileError||owner+'.'+name+' compiles');return state;};
 const row=build('OwnedRows','row','(I)[I'),field=build('OwnedRows','field','()[I'),twoFields=build('OwnedRows','twoFields','()[I');
 build('OwnedRows','relay','(I)[I');build('OwnedRows','recursive','(II)[I');const select=build('OwnedRows','select','(Z[I)[I');
 const touch=build('ReturnOwnership','touch','(LRowState;I)I');
 const scan=build('ReturnOwnership','scan','(LOwnedRows;LRowState;I)I'),relay=build('ReturnOwnership','relay','(LOwnedRows;)I'),recursive=build('ReturnOwnership','recursive','(LOwnedRows;)I');
 t.ok(scan.meta.nativeObjectRegionBlockCount>0,'caller uses the established closed-call region proof');
 t.ok(scan.meta.nativeArrayResultOwnershipSites>0,'private returned headers feed the regional metadata cache');
 const book=makeObjectRef(j,'OwnedRows',newFields(j,'OwnedRows')),state=makeObjectRef(j,'RowState',newFields(j,'RowState'));
 const rows=allocMultiArray(j,'[[I',[2,2]);rows[0].set([3,5]);rows[1].set([7,11]);
 writeField(book.fields,'OwnedRows.rows',rows);writeField(book.fields,'OwnedRows.direct',rows[1]);writeField(state.fields,'RowState.input',rows[0]);
 const raw=(s,args)=>{const frame=new Frame(s.method);frame.className=s.key.split('.')[0];s.meta.box.frame=frame;
  try{const status=s.run(...args,0,1e8);return {status,frame,value:status===-1?takeWasmReturnValue(s.meta):undefined};}finally{s.meta.box.frame=null;}};
 const cleaned=()=>[...w.nativeArrayResults.values()].every(r=>r.base.value===-2&&r.length.value===0&&r.owned.value===0);
 const record=w.nativeArrayResults.get(row.key);
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 const first=raw(scan,[book,state,4]);t.equal(first.status,-1,'owned rows finish in native code');t.equal(first.value,52,'alternating returned values keep their actual headers');
 t.equal(scan.meta.importStats.get('native_body_array_header')||0,0,'returned private proof avoids a second host ownership lookup');
 t.ok(cleaned(),'caller drains base, length and ownership on return');
 t.equal(raw(relay,[book]).value,11,'ownership transport composes across a relay');t.equal(raw(recursive,[book]).value,11,'recursive return transport keeps the actual final value');t.ok(cleaned(),'nested callers release every payload');
 t.equal(twoFields.meta.nativeArrayOwnershipLocalCount,1,'only the actual returned identity needs an ownership local');
 t.equal(raw(twoFields,[book]).value,rows[1],'liveness keeps the final return identity');
 t.equal(w.nativeArrayResults.get(twoFields.key).owned.value,1,'returning identity retains its private proof');
 t.equal(raw(field,[book]).value,rows[1],'direct field return preserves identity');t.equal(w.nativeArrayResults.get(field.key).owned.value,1,'private field header supplies ownership');
 t.equal(raw(select,[book,0,rows[0]]).value,rows[0],'parameter return preserves identity');t.equal(w.nativeArrayResults.get(select.key).owned.value,0,'ordinary parameter transport is not an ownership proof');
 for(const r of w.nativeArrayResults.values()){r.base.value=-2;r.length.value=0;r.owned.value=0;}
 const original=rows[0],alias=new Int32Array(j.wasmHeap.memory.buffer,original.byteOffset,2);alias.type='[I';alias.wasmBase=original.byteOffset;rows[0]=alias;
 const denied=raw(scan,[book,state,1]);t.ok(denied.status>=0,'unregistered alias cannot borrow private ownership');
 t.equal(getOp(denied.frame.instructions[denied.status].instruction),'iaload','alias refusal stays at its first certified access');t.ok(cleaned(),'alias refusal leaves no published certificate');rows[0]=original;
 const other=await makeVm(),foreign=other.wasmHeap.alloc('[I',2);foreign.type='[I';foreign.set([13,17]);rows[0]=foreign;
 const refused=raw(scan,[book,state,1]);t.ok(refused.status>=0,'foreign memory cannot borrow private ownership');t.ok(cleaned(),'foreign refusal clears the return payload');rows[0]=original;
 let getterCalls=0;const foreignRows=Object.assign([],{type:'[[I'});
 for(let i=0;i<2;i++)Object.defineProperty(foreignRows,i,{get(){getterCalls++;return rows[i];}});
 writeField(book.fields,'OwnedRows.rows',foreignRows);
 const before=scan.meta.importStats.get('native_body_array_header')||0;
 t.equal(raw(scan,[book,state,2]).value,26,'foreign getter returning an owned row retains exact results');t.equal(getterCalls,2,'getter runs once per actual read');
 t.equal((scan.meta.importStats.get('native_body_array_header')||0)-before,2,'opaque producer earns no private certificate merely from its return type');t.ok(cleaned(),'opaque return leaves no certificate');
 writeField(book.fields,'OwnedRows.rows',rows);w.canonicalDirectLinks.withdraw(row.key);
 const fallbackBefore=scan.meta.importStats.get('native_body_array_header')||0;
 t.equal(raw(scan,[book,state,2]).value,26,'withdrawn producer retains its JavaScript bridge result');
 t.equal((scan.meta.importStats.get('native_body_array_header')||0)-fallbackBefore,2,'bridge cannot lend metadata produced by its nested native call');t.ok(cleaned(),'bridge clears nested metadata');
 w.canonicalDirectLinks.publish(row);t.equal(raw(scan,[book,state,2]).value,26,'safe republication restores native ownership transfer');t.ok(cleaned(),'republication payload is consumed');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'ownership, fallbacks and recursive calls compile no guest methods');t.end();
});
