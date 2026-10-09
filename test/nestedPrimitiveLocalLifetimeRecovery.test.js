'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawnSync}=require('node:child_process');
const {splitPrimitiveLocalLifetimes:root,splitNestedPrimitiveLocalLifetimes:split}=require('../src/decompiler/primitiveLocalLifetimeRecovery');

test('separates nested phases only when their block contains every local use',()=>{
 const source='int x;for(int i=0;i<n;i++){if(first){x=read();use(x);}if(second){x=other();use(x);}for(x=0;x<m;x++){use(x);}}return answer;';
 assert.equal(root(source).declarationsAdded,0);const r=split(source,{retainDiagnostics:true});assert.equal(r.localsSplit,1);assert.equal(r.declarationsAdded,2);assert.equal(r.diagnostics.locals[0].nested,true);
 assert.match(r.source,/xLifetime1=other\(\);use\(xLifetime1\)/);assert.match(r.source,/for\(xLifetime2=0;xLifetime2<m;xLifetime2\+\+\)/);
 assert.equal(r.source.replace(/int xLifetime\d+;\n/g,'').replace(/xLifetime\d+/g,'x'),source);
 assert.equal(split(source).source,r.source);
});

test('loop headers, outgoing uses, iteration-carried reads and conditional joins stay connected',()=>{
 for(const source of [
 'int x;x=0;while(x<n){x=first();use(x);x=second();use(x);}',
 'int x;for(int i=0;i<n;i++){x=first();use(x);x=second();use(x);}use(x);',
 'int x;for(int i=0;i<n;i++){if(i==0)x=first();use(x);x=second();use(x);}',
 'int x;for(int i=0;i<n;i++){x=first();use(x);if(flag)x=second();use(x);}',
 'int x;for(int i=0;i<n;use(x)){x=first();use(x);x=second();use(x);}',
 'int x;while(flag){use(x);x=second();use(x);}',
 ])assert.equal(split(source).source,source,source);
});

test('enclosing label and loop contexts survive abrupt nested phases',()=>{
 const source='int x;Outer:for(int i=0;i<n;i++){if(first){x=read();use(x);if(stop)continue Outer;}if(second){x=other();use(x);if(stop)break Outer;}}';
 const r=split(source);assert.equal(r.declarationsAdded,1);assert.match(r.source,/continue Outer/);assert.match(r.source,/break Outer/);
 for(const source of ['int x;for(int i=0;i<n;i++){x=1;use(x);try{x=2;use(x);}finally{use(x);}}','int x;for(int i=0;i<n;i++){x=1;use(x);Runnable r=()->use(x);x=2;use(x);}'])assert.equal(split(source).source,source);
});

test('nested compiler option requires the root option and reserves formal names',()=>{
 const {shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;
 const keys=['CFR_JS_SPLIT_PRIMITIVE_LIFETIMES','CFR_JS_SPLIT_NESTED_PRIMITIVE_LIFETIMES'],previous=keys.map(k=>process.env[k]);
 const source='int x;for(int i=0;i<n;i++){if(first){x=1;use(x);}if(second){x=2;use(x);}}';
 try{delete process.env[keys[0]];process.env[keys[1]]='1';let body=[source];finish(body);assert.equal(body.join('\n'),source);
  process.env[keys[0]]='1';delete process.env[keys[1]];body=[source];finish(body);assert.equal(body.join('\n'),source);
  process.env[keys[1]]='1';finish(body,['xLifetime1']);assert.match(body.join('\n'),/int xLifetime2;/);
 }finally{keys.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});}
});

test('native nested phases match independent event lists, partial writes and finally overrides',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nested-primitive-native-'));
 const run=(cmd,args)=>{const out=path.join(directory,'out'),err=path.join(directory,'err'),fds=[out,err].map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(err,'utf8'));return fs.readFileSync(out,'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const body=`int x;int y;Outer:for(int i=0;i<limit;i++){
  if((mask&1)!=0){x=seed+i;y=seed+10;event((x*11)^y);if(i==2&&(mask&4)!=0)continue Outer;}
  if((mask&2)!=0){x=seed-i;y=seed-10;event((x*11)^y);}
  for(x=0;x<3;x++){y=i+x;if(x==1&&(mask&8)!=0)continue;event(100+i*3+x+y);}
 }return state;`;
 const recovered=split(body);assert.equal(recovered.localsSplit,2);assert.equal(recovered.declarationsAdded,4);
 const java=`import java.util.*;public class NestedPrimitivePhases{
 static int state,events,failAt;static int[] writes=new int[128];static final RuntimeException FAILURE=new RuntimeException();static final Object lock=new Object();
 static void event(int value){writes[events]=value;state=state*31+value;if(events++==failAt)throw FAILURE;}
 static int original(int seed,int limit,int mask){${body}}
 static int recovered(int seed,int limit,int mask){${recovered.source}}
 static int oracle(int seed,int limit,int mask){ArrayList<Integer> values=new ArrayList<>();for(int i=0;i<limit;i++){
  if((mask&1)!=0){values.add(((seed+i)*11)^(seed+10));if(i==2&&(mask&4)!=0)continue;}
  if((mask&2)!=0)values.add(((seed-i)*11)^(seed-10));
  for(int j=0;j<3;j++)if(j!=1||(mask&8)==0)values.add(100+4*i+2*j);
 }for(int value:values)event(value);return state;}
 static String invoke(int variant,int seed,int limit,int mask,int mode){state=events=0;Arrays.fill(writes,0);String kind="return";int result=0;
 try{synchronized(lock){try{result=variant==0?original(seed,limit,mask):variant==1?recovered(seed,limit,mask):oracle(seed,limit,mask);}finally{state=state*31+991;if(mode==1)throw new IllegalStateException();}}}
 catch(RuntimeException error){if(error==FAILURE)kind="same-failure";else if(error instanceof IllegalStateException)kind="override";else throw error;}
 if(Thread.holdsLock(lock))throw new AssertionError("monitor retained");return kind+":"+result+":"+state+":"+events+":"+Arrays.toString(writes);}
 public static void main(String[] args){int cases=0;for(int seed=-4;seed<=4;seed++)for(int limit=-2;limit<=5;limit++)for(int mask=0;mask<16;mask++)for(int failure=-1;failure<21;failure++)for(int mode=0;mode<2;mode++){
 failAt=failure;String expected=invoke(2,seed,limit,mask,mode);for(int v=0;v<2;v++)if(!invoke(v,seed,limit,mask,mode).equals(expected))throw new AssertionError(seed+":"+limit+":"+mask+":"+failure+":"+mode);cases++;}System.out.println(cases);}}
 `;
 try{fs.writeFileSync(path.join(directory,'NestedPrimitivePhases.java'),java);run('javac',['--release','8','-d',directory,path.join(directory,'NestedPrimitivePhases.java')]);assert.equal(run('java',['-cp',directory,'NestedPrimitivePhases']),'50688');}finally{fs.rmSync(directory,{recursive:true,force:true});}
});
