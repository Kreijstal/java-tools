'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {splitInitializedPrimitiveLocalLifetimes:initial,splitNestedInitializedPrimitiveLocalLifetimes:split}=require('../src/decompiler/primitiveLocalLifetimeRecovery');

test('a second nested pass exposes independently assigned roles inside earlier phases',()=>{
 const source='int x=0;try{if(first){x=one();use(x);x=two();use(x);}if(second){x=three();use(x);x=four();use(x);}}finally{finish();}';
 const first=initial(source);assert.equal(first.declarationsAdded,1);const next=split(first.source,{retainDiagnostics:true});assert.equal(next.localsSplit,2);assert.equal(next.declarationsAdded,2);assert.ok(next.diagnostics.locals.every(l=>l.nested));
 assert.equal(split('int x=0;x=one();use(x);x=two();use(x);').localsSplit,0,'root blocks are excluded');
 const reserved=split(first.source,{reservedNames:['xLifetime2']});assert.ok(!reserved.source.includes('int xLifetime2;'));
});
test('second nested passes retain loop incoming values, handler reads and conditional resets',()=>{
 for(const source of ['int x=0;while(next()){use(x);x=one();use(x);x=two();use(x);}',
 'int x=0;try{x=one();use(x);x=two();use(x);}finally{use(x);}',
 'int x=0;try{x=one();use(x);x=two();use(x);}catch(RuntimeException e){use(x);}',
 'int x=0;while(next()){x=one();use(x);if(flag)x=two();use(x);}',
 'int x=0;while(next()){x=one();use(x);Runnable r=()->use(x);x=two();use(x);}',
 'int x=0;while(next()){x=one();Object a=new int[x];x=two();use(x);}'])assert.equal(split(source).source,source,source);
});
test('the nested compiler flag requires initialized recovery and leaves defaults unchanged',()=>{
 const finish=require('../src/decompiler/cfr')._internals.shareExistingExitTails;
 const keys=['CFR_JS_SPLIT_INITIALIZED_PRIMITIVE_LIFETIMES','CFR_JS_SPLIT_NESTED_INITIALIZED_PRIMITIVE_LIFETIMES'],old=keys.map(k=>process.env[k]);
 const source='int x=0;try{if(first){x=1;use(x);x=2;use(x);}if(second){x=3;use(x);x=4;use(x);}}finally{finish();}';
 try{delete process.env[keys[0]];process.env[keys[1]]='1';let body=[source];finish(body);assert.equal(body.join('\n'),source);
  process.env[keys[0]]='1';delete process.env[keys[1]];body=[source];finish(body);const before=body.join('\n');
  process.env[keys[1]]='1';body=[source];finish(body);assert.notEqual(body.join('\n'),before);assert.ok(body.join('\n').includes('xLifetime1Lifetime1'));
 }finally{keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}
});
test('native nested literal roles preserve independent event traces, float bits, failures and monitors',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nested-initialized-native-'));
 const run=(cmd,args)=>{const out=path.join(directory,'out'),err=path.join(directory,'err'),fds=[out,err].map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(err,'utf8'));return fs.readFileSync(out,'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const loop='Outer:for(int i=0;i<limit;i++){if((mask&1)!=0){x=seed+i;v=Float.intBitsToFloat(seed^i);event(x);event(Float.floatToRawIntBits(v));if(i==1&&(mask&4)!=0)continue Outer;}if((mask&2)!=0){x=seed-i;v=Float.intBitsToFloat(seed^~i);event(x);event(Float.floatToRawIntBits(v));}for(x=0;x<2;x++){v=(float)(i+x);event(x);event(Float.floatToRawIntBits(v));}}';
 const oracle='Outer:for(int i=0;i<limit;i++){if((mask&1)!=0){event(seed+i);event(Float.floatToRawIntBits(Float.intBitsToFloat(seed^i)));if(i==1&&(mask&4)!=0)continue Outer;}if((mask&2)!=0){event(seed-i);event(Float.floatToRawIntBits(Float.intBitsToFloat(seed^~i)));}for(int inner=0;inner<2;inner++){event(inner);event(Float.floatToRawIntBits((float)(i+inner)));}}';
 const protects=[s=>s,s=>`try{${s}}finally{event(991);if(mode==1)throw OVERRIDE;}`,s=>`synchronized(lock){${s}}`,s=>`try{${s}}catch(IllegalStateException e){event(992);if(e!=FAILURE)throw e;}finally{event(991);}`];
 try{let methods='';for(let c=0;c<protects.length;c++){const source='int x=0;float v=-0.0f;'+protects[c](loop)+'return snapshot();',r=split(source);assert.equal(r.localsSplit,2);assert.equal(r.declarationsAdded,4);for(const[name,body]of[['old',source],['next',r.source],['oracle',protects[c](oracle)+'return snapshot();']])methods+=`static String ${name}${c}(int seed,int limit,int mask,int mode){${body}}\n`;}
 const java=`public class NestedInitializedPhases{static long state;static int count,failAt;static Object lock;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(long v){state=state*31+v;state=state*31+(Thread.holdsLock(lock)?1:0);if(count++==failAt)throw FAILURE;}static String snapshot(){return state+":"+count;}${methods}
 static String take(int kind,int variant,int seed,int limit,int mask,int mode){state=count=0;lock=new Object();String result;try{switch(kind){${protects.map((_,c)=>`case ${c}:result=variant==0?old${c}(seed,limit,mask,mode):variant==1?next${c}(seed,limit,mask,mode):oracle${c}(seed,limit,mask,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("monitor retained");return result+":"+snapshot();}
 public static void main(String[]args){int cases=0;for(int kind=0;kind<4;kind++)for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,7,0x7fc00001,0x7f800001,Integer.MAX_VALUE})for(int limit:new int[]{-1,0,1,2,4})for(int mask=0;mask<8;mask++)for(int mode=0;mode<2;mode++)for(int failure=-1;failure<5;failure++){failAt=failure;String expected=take(kind,2,seed,limit,mask,mode);for(int variant=0;variant<2;variant++)if(!expected.equals(take(kind,variant,seed,limit,mask,mode)))throw new AssertionError(kind+":"+variant+":"+seed+":"+limit+":"+mask+":"+failure+":"+expected);cases++;}System.out.println(cases);}}
 `;const file=path.join(directory,'NestedInitializedPhases.java');fs.writeFileSync(file,java);run('javac',['--release','8','-d',directory,file]);assert.equal(run('java',['-Xmx128m','-cp',directory,'NestedInitializedPhases']),'15360');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
