'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const recovery=require('../src/decompiler/primitiveLocalLifetimeRecovery');
const split=recovery.splitConditionalPrimitiveLocalLifetimes;

function undo(source){return source.replace(/int xLifetime\d+(?:Lifetime\d+)*;\n/g,'').replace(/xLifetime\d+(?:Lifetime\d+)*/g,'x');}

test('separates protected conditional arms and composes with sequential recovery',()=>{
 const source='int x=0;try{if(flag){x=1;use(x);x=2;use(x);}else{x=3;use(x);x=4;use(x);}}catch(RuntimeException failure){throw failure;}';
 const r=split(source,{retainDiagnostics:true});
 assert.equal(r.localsSplit,1);assert.equal(r.declarationsAdded,1);assert.equal(r.diagnostics.locals[0].conditional,true);
 assert.equal(undo(r.source),source);assert.equal(split(r.source).source,r.source);assert.deepEqual(split(source,{retainDiagnostics:true}),r);
 assert.equal(recovery.splitInitializedPrimitiveLocalLifetimes(source).localsSplit,0,'existing API refusal contract stays intact');
 const composed=recovery.splitInitializedPrimitiveLocalLifetimes(r.source);assert.equal(composed.declarationsAdded,2);assert.equal(undo(composed.source),source);
});

test('partitions nested arms completely with stable source order and reserved names',()=>{
 const source='int x=0;if(a){if(b){x=1;use(x);}else{x=2;use(x);}}else{x=3;use(x);}';
 const r=split(source,{reservedNames:['xLifetime1']});assert.equal(r.declarationsAdded,2);
 assert.match(r.source,/else\{xLifetime2=2;use\(xLifetime2\);\}/);assert.match(r.source,/else\{xLifetime3=3;use\(xLifetime3\);\}/);
 assert.equal(undo(r.source),source);assert.equal(split(r.source).source,r.source);
});

test('refuses incoming, condition, outgoing, handler and loop-carried values',()=>{
 for(const source of [
  'int x=0;if(flag){use(x);x=1;}else{x=2;use(x);}',
  'int x=0;if(x==0){x=1;use(x);}else{x=2;use(x);}',
  'int x=0;if(flag){x=1;use(x);}else{x=2;use(x);}use(x);',
  'int x=0;try{if(flag){x=1;use(x);}else{x=2;use(x);}}catch(RuntimeException e){use(x);}',
  'int x=0;try{if(flag){x=1;use(x);}else{x=2;use(x);}}finally{use(x);}',
  'int x=0;for(int i=0;i<n;i++){if(flag){if(i==0)x=1;use(x);}else{x=2;use(x);}}',
  'int x=0;if(flag){for(int i=0;i<n;i++){x=i;}use(x);}else{x=2;use(x);}',
  'int x=0;if(flag){L:{if(skip)break L;x=1;}use(x);}else{x=2;use(x);}',
  'int x=0;if(flag){ready&&(x=1)>0;use(x);}else{x=2;use(x);}',
  'int x=0;for(;x<n;){if(flag){x=1;use(x);}else{x=2;use(x);}}',
 ])assert.equal(split(source).source,source,source);
});

test('keeps unsupported scopes, unbraced arms, shadows and lexical ambiguity untouched',()=>{
 for(const source of [
  'int x=read();if(flag){x=1;use(x);}else{x=2;use(x);}',
  'int x=0;if(flag)x=1;else{x=2;use(x);}',
  'int x=0;if(flag){x=1;use(x);}else{x=2;use(this.x+x);}',
  'int x=0;if(flag){x=1;use(x);}else{x=2;use(x());}',
  'int x=0;if(flag){x=1;use(x);}else{x=2;use(x);}{int x=3;}',
  'int x=0;if(flag){x=1;use(x);}else{x=2;Runnable r=()->use(x);}',
  'int x=0;if(flag){x=1;use(x);}else{x=2;class C{int get(){return x;}}}',
  'int x=0;if(flag){x=1;use(x);}else{x=2;use(x);/*retain*/}',
  'int x=0;if(flag){x=1;use(new int[x]);}else{x=2;use(x);}',
  'int x=0;if(flag){try{x=1;use(x);}finally{cleanup();}}else{x=2;use(x);}',
  'int x=0;if(flag){do{x=1;use(x);}while(again);}else{x=2;use(x);}',
 ])assert.equal(split(source).source,source,source);
 for(const type of ['boolean','byte','short','char','int','long','float','double']){
  const source=`${type} value;if(flag){value=first();use(value);}else{value=second();use(value);}`;
  const r=split(source);assert.equal(r.localsSplit,1,type);assert.match(r.source,new RegExp(type+' valueLifetime1;'));
 }
});

test('compiler enables branch and phase recovery without application flags',()=>{
 const finish=require('../src/decompiler/cfr')._internals.shareExistingExitTails;
 const source='int x=0;try{if(flag){x=1;use(x);x=2;use(x);}else{x=3;use(x);x=4;use(x);}}catch(RuntimeException failure){throw failure;}';
 const body=[source];finish(body,['xLifetime1']);assert.equal(undo(body.join('\n')),source);
 assert.match(body.join('\n'),/int xLifetime2;/);assert.doesNotMatch(body.join('\n'),/int xLifetime1;/);
});

test('indexes independent branches with proportional work and bounds shared-branch proofs',()=>{
 function independent(n){let declarations='',body='';for(let i=0;i<n;i++){declarations+=`int x${i}=0;`;body+=`if(flag){x${i}=1;use(x${i});}else{x${i}=2;use(x${i});}`;}return declarations+body;}
 const a=split(independent(64),{retainDiagnostics:true}),b=split(independent(128),{retainDiagnostics:true});
 assert.equal(a.localsSplit,64);assert.equal(b.localsSplit,128);
 for(const key of ['nodesIndexed','tokensIndexed','proofSteps','mentionQueries','mentionComparisons'])assert.ok(b.diagnostics.work[key]<=a.diagnostics.work[key]*2.1,key);
 let declarations='',left='',right='';for(let i=0;i<512;i++){declarations+=`int x${i}=0;`;left+=`x${i}=1;use(x${i});`;right+=`x${i}=2;use(x${i});`;}
 const source=declarations+`if(flag){${left}}else{${right}}`,r=split(source,{retainDiagnostics:true});
 assert.equal(r.source,source);assert.equal(r.localsSplit,0);assert.equal(r.diagnostics.work.exhausted,true);
 assert.equal(r.diagnostics.work.proofSteps,r.diagnostics.work.limit);assert.deepEqual(split(source,{retainDiagnostics:true}),r);
});

test('native branch recovery and compiler defaults match independent effects and abrupt exits',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'conditional-primitive-native-'));
 const body=`int x=0;Outer:for(int i=0;i<limit;i++){
  if((i&1)==0){
   if((mask&8)==0){x=seed+i;event(x*7);if(i==2&&(mask&1)!=0)continue Outer;x=seed-i;event(x*11);if(i==4&&(mask&4)!=0)break Outer;}
   else{x=seed+2*i;event(x*19);if(i==2&&(mask&1)!=0)continue Outer;x=seed-2*i;event(x*23);if(i==4&&(mask&4)!=0)break Outer;}
  }else{x=seed-i;event(x*13);if(i==1&&(mask&2)!=0)break Outer;x=seed+i;event(x*17);}
 }return state;`;
 const recovered=split(body);assert.equal(recovered.declarationsAdded,2);
 const finished=[body];require('../src/decompiler/cfr')._internals.shareExistingExitTails(finished,['seed','limit','mask']);
 const java=`import java.util.*;public class ConditionalPrimitivePhases{
 static int state,events,failAt;static int[] writes=new int[128];static final RuntimeException FAILURE=new RuntimeException();static final Object LOCK=new Object();
 static void event(int value){writes[events]=value;state=state*31+value;if(events++==failAt)throw FAILURE;}
 static int original(int seed,int limit,int mask){${body}}
 static int recovered(int seed,int limit,int mask){${recovered.source}}
 static int finished(int seed,int limit,int mask){${finished.join('\n')}}
 static int oracle(int seed,int limit,int mask){ArrayList<Integer> values=new ArrayList<>();for(int i=0;i<limit;i++){
  if((i&1)==0){int stride=(mask&8)==0?1:2,first=(mask&8)==0?7:19,second=(mask&8)==0?11:23;values.add((seed+stride*i)*first);if(i==2&&(mask&1)!=0)continue;values.add((seed-stride*i)*second);if(i==4&&(mask&4)!=0)break;}
  else{values.add((seed-i)*13);if(i==1&&(mask&2)!=0)break;values.add((seed+i)*17);}
 }for(int v:values)event(v);return state;}
 static String invoke(int variant,int seed,int limit,int mask,int mode){state=events=0;Arrays.fill(writes,0);String kind="return";int result=0;
 try{synchronized(LOCK){try{result=variant==0?original(seed,limit,mask):variant==1?recovered(seed,limit,mask):variant==2?finished(seed,limit,mask):oracle(seed,limit,mask);}finally{event(991);if(mode==1)throw new IllegalStateException();}}}
 catch(RuntimeException error){if(error==FAILURE)kind="same-failure";else if(error instanceof IllegalStateException)kind="override";else throw error;}
 if(Thread.holdsLock(LOCK))throw new AssertionError("monitor retained");return kind+":"+result+":"+state+":"+events+":"+Arrays.toString(writes);}
 public static void main(String[] args){int cases=0;for(int seed=-3;seed<=3;seed++)for(int limit=-1;limit<=5;limit++)for(int mask=0;mask<16;mask++)for(int failure=-1;failure<12;failure++)for(int mode=0;mode<2;mode++){
 failAt=failure;String expected=invoke(3,seed,limit,mask,mode);for(int v=0;v<3;v++)if(!invoke(v,seed,limit,mask,mode).equals(expected))throw new AssertionError(seed+":"+limit+":"+mask+":"+failure+":"+mode);cases++;}System.out.println(cases);}}
 `;
 function run(command,args){const result=spawnSync('timeout',['30',command,...args],{encoding:'utf8',maxBuffer:1024*1024});if(result.error)throw result.error;assert.equal(result.status,0,result.stderr);return result.stdout.trim();}
 try{const source=path.join(directory,'ConditionalPrimitivePhases.java');fs.writeFileSync(source,java);run('javac',['--release','8','-d',directory,source]);assert.equal(run('java',['-Xmx256m','-Xverify:all','-cp',directory,'ConditionalPrimitivePhases']),'20384');}
 finally{fs.rmSync(directory,{recursive:true,force:true});}
});
