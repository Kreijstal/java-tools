'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{coerceExpressionForType:coerce,coerceCheckedReference:checked}=require('../src/decompiler/cfr')._internals;
const key='CFR_JS_AVOID_PROVEN_REFERENCE_CAST_BRIDGES';
function option(enabled,run){const old=process.env[key];try{if(enabled)process.env[key]='1';else delete process.env[key];return run();}finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}}
const entries=[['sample/Base','java/lang/Object',[]],['sample/Child','sample/Base',[]],['sample/Other','java/lang/Object',[]],['sample/Marker','java/lang/Object',[]],['sample/Marked','sample/Base',['sample/Marker']]];
const model={classInfo:new Map(entries.map(([className,superClassName,interfaces])=>[className,{className,superClassName,interfaces}])),superOf:new Map(entries.map(([a,b])=>[a,b])),sourceNameToInternal:new Map(entries.map(([a])=>[a.replaceAll('/','.'),a]))};
const value=type=>({code:'read()',type,precedence:100});
test('reference bridge removal is opt-in and preserves the target cast and operand once',()=>{
 const old=option(false,()=>coerce(value('sample.Base'),'sample.Child',model,false));assert.match(old.code,/\(Object\)/);
 const next=option(true,()=>coerce(value('sample.Base'),'sample.Child',model,false));assert.equal(next.code,'(sample.Child) (read())');assert.equal(next.type,'sample.Child');assert.equal(next.code.split('read()').length-1,1);
});
test('known widening conversions retain explicit overload/receiver pinning when requested',()=>option(true,()=>{
 assert.equal(coerce(value('sample.Child'),'sample.Base',model,true).code,'read()');
 assert.equal(coerce(value('sample.Child'),'sample.Base',model,false).code,'(sample.Base) (read())');
 assert.equal(coerce(value('sample.Child[]'),'sample.Base[]',model,false).code,'(sample.Base[]) (read())');
}));
test('unknown, unrelated, primitive and incompatible array types retain existing behavior',()=>{
 for(const[source,target,m]of [['sample.Other','sample.Child',model],['sample.Base','sample.Child',null],['int','sample.Child',model],['int[]','sample.Child[]',model],['sample.Base[]','int[]',model],['sample.Missing','sample.Child',model]]){
  assert.equal(option(true,()=>coerce(value(source),target,m,false).code),option(false,()=>coerce(value(source),target,m,false).code),source+' -> '+target);
 }
});
test('covariant reference arrays and proven interface implementations can narrow directly',()=>option(true,()=>{
 for(const[source,target]of [['sample.Base[]','sample.Child[]'],['Object[]','sample.Child[][]'],['sample.Marker','sample.Marked']])assert.ok(!coerce(value(source),target,model,false).code.includes('(Object)'),source+' -> '+target);
}));
test('native direct casts match bridge casts and independent expected outcomes',()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'proven-reference-casts-'));
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:1024*1024});if(r.error)throw r.error;assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 try{
  const m={classInfo:new Map([['Base',{className:'Base',superClassName:'java/lang/Object',interfaces:[]}],['Child',{className:'Child',superClassName:'Base',interfaces:[]}]]),sourceNameToInternal:new Map([['Base','Base'],['Child','Child']])};
  const source=option(false,()=>coerce({code:'read(input)',type:'Base',precedence:100},'Child',m,false)).code;
  const candidate=option(true,()=>coerce({code:'read(input)',type:'Base',precedence:100},'Child',m,false)).code;
  const java=`public class CastOracle{static class Base{}static class Child extends Base{}static int reads;static Object lock;static String trace;static final RuntimeException FAILURE=new IllegalStateException();static Base read(Base input){reads++;trace+="r";if(reads==2)throw FAILURE;return input;}static String old(Base input){synchronized(lock){try{Child c=${source};trace+=c==input?"same":"different";return trace;}catch(ClassCastException e){trace+="cast";return trace;}finally{trace+=Thread.holdsLock(lock)?"locked":"unlocked";}}}static String next(Base input){synchronized(lock){try{Child c=${candidate};trace+=c==input?"same":"different";return trace;}catch(ClassCastException e){trace+="cast";return trace;}finally{trace+=Thread.holdsLock(lock)?"locked":"unlocked";}}}static String take(boolean candidate,Base input,int initial){reads=initial;trace="";lock=new Object();String answer;try{answer=candidate?next(input):old(input);}catch(Throwable e){answer=e==FAILURE?"failure":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("lock leaked");return answer+":"+trace+":"+reads;}public static void main(String[]args){int cases=0;for(Base input:new Base[]{null,new Base(),new Child()})for(int initial:new int[]{0,1}){String branch=initial==1?"failure":input instanceof Child||input==null?"rsame":"rcast";String trace=initial==1?"rlocked":branch+"locked";String expected=branch+":"+trace+":"+(initial+1);if(!expected.equals(take(false,input,initial))||!expected.equals(take(true,input,initial)))throw new AssertionError(expected);cases++;}System.out.println(cases);}}`;
  fs.writeFileSync(path.join(temporary,'CastOracle.java'),java);run('javac',['--release','8','-d',temporary,path.join(temporary,'CastOracle.java')]);assert.equal(run('java',['-Xmx64m','-cp',temporary,'CastOracle']),'6');
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});

test('bytecode checkcast cleanup only removes bridges and retains default widening output',()=>{
 for(const[source,target]of [['sample.Base','sample.Child'],['sample.Base[]','sample.Child[]'],['sample.Marker','sample.Marked']]){const before=option(false,()=>checked(value(source),target,model)).code,after=option(true,()=>checked(value(source),target,model)).code;assert.equal(after,before.replace('(Object) ',''));}
 for(const[source,target]of [['sample.Child','Object'],['sample.Child[]','Object'],['sample.Child','sample.Child'],['sample.Other','sample.Child'],['sample.Child','sample.Base']])assert.equal(option(true,()=>checked(value(source),target,model)).code,option(false,()=>checked(value(source),target,model)).code);
});
