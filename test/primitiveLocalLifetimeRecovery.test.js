'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawnSync}=require('node:child_process');
const {splitPrimitiveLocalLifetimes:split}=require('../src/decompiler/primitiveLocalLifetimeRecovery');

test('separates closed primitive phases without changing expression or effect tokens',()=>{
 const source='int x;\nfor(x=0;x<n;x++){use(x);}\nx=read(); while(x<n){use(x++);}\nif(flag){x=7; use(x);}\nfor(x=0;x<m;x++){use(x);}\nreturn answer;';
 const r=split(source,{retainDiagnostics:true});assert.equal(r.localsSplit,1);assert.equal(r.declarationsAdded,3);
 assert.equal(r.diagnostics.locals[0].groups,4);assert.match(r.source,/xLifetime1=read\(\)/);assert.match(r.source,/if\(flag\)\{xLifetime2=7; use\(xLifetime2\);\}/);
 const undo=r.source.replace(/int xLifetime\d+;\n/g,'').replace(/xLifetime\d+/g,'x');assert.equal(undo,source);
 assert.equal(split(r.source).declarationsAdded,0,'idempotent');assert.equal(split(source).source,r.source,'deterministic');
});

test('keeps reads of reaching values together across joins and loops',()=>{
 for(const source of ['int x;x=read();if(flag)x=7;use(x);','int x;x=read();while(flag){use(x);x++;}use(x);','int x;x=0;for(;x<n;){if(flag)continue;use(x++);}use(x);','int x; L:{if(flag){x=7;break L;}x=read();}use(x);','int x;x=read();if(flag)return x;use(x);'])assert.equal(split(source).source,source,source);
 const r=split('int x;x=read();if(flag)x=7;use(x);x=other();use(x);');assert.equal(r.declarationsAdded,1);assert.match(r.source,/xLifetime1=other\(\);use\(xLifetime1\)/);
});

test('refuses read-before-write paths, conditional expression definitions and loop update hazards',()=>{
 for(const source of [
 'int x;for(;flag;x++){if(flag)continue;x=7;}use(x);x=9;use(x);',
 'int x;while(flag){if(flag)continue;x=7;use(x);}use(x);x=9;use(x);',
 'int x;flag&&(x=7)>0;use(x);x=9;use(x);',
 'int x; L:{if(flag)break L;x=7;}use(x);x=9;use(x);',
 'int x;x=7;use(x);if(flag)x=9;use(x);',
 'int x;x=7;use(x);for(;flag;use(x)){if(flag)continue;x=9;}use(x);',
 ])assert.equal(split(source).source,source,source);
});

test('protected regions, captures, shadows, comments and ambiguous spellings remain untouched',()=>{
 for(const source of [
 'int x;x=1;use(x);try{x=2;use(x);}finally{use(x);}',
 'int x;x=1;use(x);synchronized(lock){x=2;use(x);}',
 'int x;x=1;use(x);Runnable r=()->use(x);x=2;use(x);',
 'int x;x=1;use(x);class C{int value(){return x;}}x=2;use(x);',
 'int x;x=1;use(x);{int x=2;use(x);}',
 'int x;x=1;use(x);x=2;use(this.x+x);',
 'int x;x=1;use(x);x=2;use(x());',
 'int x;x=1;use(x);/* keep */x=2;use(x);',
 'int x;x=1;use(x);do{x=2;use(x);}while(flag);',
 'int x=0;x=1;use(x);x=2;use(x);',
 ])assert.equal(split(source).source,source,source);
});

test('labeled continue targets, short-circuit assignments, primitive types and name collisions are stable',()=>{
 const source='int x;int xLifetime1=9;L:for(x=0;x<n;x++){if(flag)continue L;use(x);}if(flag){x=2;}else{x=3;}use(x);';
 const r=split(source);assert.equal(r.declarationsAdded,1);assert.match(r.source,/int xLifetime2;/);assert.match(r.source,/xLifetime2=2/);assert.match(r.source,/continue L/);
 for(const type of ['boolean','byte','short','char','int','long','float','double']){const s=`${type} value;value=first();use(value);value=second();use(value);`;const n=split(s);assert.equal(n.declarationsAdded,1);assert.match(n.source,new RegExp(type+' valueLifetime1;'));}
 assert.match(split('int x;x=first();use(x);x=second();use(x);',{reservedNames:['xLifetime1']}).source,/int xLifetime2;/);
 const constructor=split('this(7); int x; x=first();use(x);x=second();use(x);').source;
 assert.ok(constructor.startsWith('this(7); int x; int xLifetime1;'));
});

test('compiler option is explicit and reserves unused formal names',()=>{
 const{shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;
 const previous=process.env.CFR_JS_SPLIT_PRIMITIVE_LIFETIMES;
 const source='int x;\nx=first();use(x);x=second();use(x);';
 try{delete process.env.CFR_JS_SPLIT_PRIMITIVE_LIFETIMES;const body=[source];finish(body);assert.equal(body.join('\n'),source);
  process.env.CFR_JS_SPLIT_PRIMITIVE_LIFETIMES='1';finish(body,['xLifetime1']);assert.match(body.join('\n'),/int xLifetime2;/);
 }finally{if(previous===undefined)delete process.env.CFR_JS_SPLIT_PRIMITIVE_LIFETIMES;else process.env.CFR_JS_SPLIT_PRIMITIVE_LIFETIMES=previous;}
});

test('native phases match an independent event oracle including throws and outer finally effects',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'primitive-lifetimes-native-'));
 const run=(cmd,args)=>{const out=path.join(directory,'out'),err=path.join(directory,'err'),fds=[out,err].map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(err,'utf8'));return fs.readFileSync(out,'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const body=`int x; long wide; float fraction; boolean selected;
 for(x=0;x<limit;x++){event(x*3);}
 x=seed;while(x<limit){if(x==-2){x++;continue;}event(100+x);x++;}
 if(flag){x=seed+7;event(x);}
 for(x=0;x<limit;x++){if(x==2)break;event(200+x);}
 wide=Long.MAX_VALUE;event((int)(wide+seed));
 wide=Long.MIN_VALUE;event((int)(wide-seed));
 fraction=Float.intBitsToFloat(bits);event(Float.floatToIntBits(fraction+0.0f));
 fraction=Float.intBitsToFloat(bits);event(Float.floatToIntBits(fraction*1.0f));
 selected=flag;event(selected?1:0);selected=!flag;event(selected?1:0);
 return state;`;
 const recovered=split(body);assert.equal(recovered.localsSplit,4);assert.equal(recovered.declarationsAdded,6);
 const java=`import java.util.*;public class PrimitivePhases{
 static int state,events,failAt;static final RuntimeException FAILURE=new RuntimeException();static final Object lock=new Object();
 static void event(int value){state=state*31+value;if(events++==failAt)throw FAILURE;}
 static int original(int seed,int limit,boolean flag,int bits){${body}}
 static int recovered(int seed,int limit,boolean flag,int bits){${recovered.source}}
 static int oracle(int seed,int limit,boolean flag,int bits){
  ArrayList<Integer> values=new ArrayList<>();for(int i=0;i<limit;i++)values.add(i*3);
  for(int i=seed;i<limit;i++)if(i!=-2)values.add(100+i);
  if(flag)values.add(seed+7);for(int i=0;i<Math.min(limit,2);i++)values.add(200+i);
  values.add(seed-1);values.add(-seed);
  values.add(Float.floatToIntBits(Float.intBitsToFloat(bits)+0.0f));
  values.add(Float.floatToIntBits(Float.intBitsToFloat(bits)*1.0f));values.add(flag?1:0);values.add(flag?0:1);
  for(int v:values)event(v);return state;
 }
 static String invoke(int variant,int seed,int limit,boolean flag,int bits,int mode){state=events=0;String kind="return";int result=0;
  try{synchronized(lock){try{result=variant==0?original(seed,limit,flag,bits):variant==1?recovered(seed,limit,flag,bits):oracle(seed,limit,flag,bits);}finally{state=state*31+991;if(mode==1)throw new IllegalStateException();}}}
  catch(RuntimeException error){if(error==FAILURE)kind="same-failure";else if(error instanceof IllegalStateException)kind="override";else throw error;}
  if(Thread.holdsLock(lock))throw new AssertionError("monitor retained");return kind+":"+result+":"+state+":"+events;
 }
 public static void main(String[] args){int cases=0;int[] values={0,0x80000000,0x3f800000,0x7f800000,0xff800000,0x7fc00001,0x7f800001,0x00000001};
  for(int seed=-5;seed<=5;seed++)for(int limit=-2;limit<=5;limit++)for(boolean flag:new boolean[]{false,true})for(int bits:values)for(int failure=-1;failure<24;failure++)for(int mode=0;mode<2;mode++){
   failAt=failure;String expected=invoke(2,seed,limit,flag,bits,mode);for(int v=0;v<2;v++)if(!invoke(v,seed,limit,flag,bits,mode).equals(expected))throw new AssertionError(seed+":"+limit+":"+bits+":"+failure+":"+mode);cases++;}
  System.out.println(cases);
 }} `;
 try{fs.writeFileSync(path.join(directory,'PrimitivePhases.java'),java);run('javac',['--release','8','-d',directory,path.join(directory,'PrimitivePhases.java')]);assert.equal(run('java',['-cp',directory,'PrimitivePhases']),'70400');}finally{fs.rmSync(directory,{recursive:true,force:true});}
});
