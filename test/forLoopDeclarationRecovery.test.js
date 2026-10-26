'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');const {spawnSync}=require('child_process');
const {localizeForLoopDeclarations:recover}=require('../src/decompiler/javaAstEmitter');
const {decompileClassFile}=require('../src/decompiler/cfr');

for(const [name,context] of [
 ['plain',loop=>loop],['protected',loop=>`try{${loop}}finally{cleanup();}`],
 ['monitor',loop=>`synchronized(lock){${loop}}`],
 ['handler',loop=>`try{work();}catch(RuntimeException failure){${loop}}`],
 ['nested block',loop=>`if(flag){{${loop}}}`],
])test(`moves a sole primitive counter into its ${name} loop`,()=>{
 const source='int counter;'+context('Scan: for(counter=initial();counter<limit;counter++){consume(counter);if(skip())continue Scan;}');
 const result=recover(source);assert.equal(result.declarationsMoved,1);
 assert.equal(result.source,source.replace('int counter;','').replace('for(counter=','for(int counter='));
 assert.deepEqual(recover(result.source),{source:result.source,declarationsMoved:0});
});

test('retains primitive spelling and deletes an otherwise empty declaration line',()=>{
 for(const [type,value]of [['boolean','false'],['byte','0'],['short','-1'],['char',"'x'"],['int','+1'],['long','0x8000000000000000L'],['float','-0.0f'],['double','-0.0d']]){
  const source=`${type} counter=${value};\nfor(counter=first;guard(counter);counter=next){consume(counter);}`;
  const result=recover(source);assert.equal(result.declarationsMoved,1);assert.equal(result.source,`for(${type} counter=first;guard(counter);counter=next){consume(counter);}`);
 }
});

test('moves a nested block declaration and independent counters without reprinting other code',()=>{
 const source='{ int a; for(a=0;a<2;a++){use(a);} }\nint b=0;\nfor(b=0;b<3;b++){use(b);}';
 const result=recover(source);assert.equal(result.declarationsMoved,2);
 assert.equal(result.source,'{  for(int a=0;a<2;a++){use(a);} }\nfor(int b=0;b<3;b++){use(b);}');
});

for(const[name,source]of [
 ['effectful initializer','int counter=effect();for(counter=0;counter<3;counter++){use(counter);}'],
 ['throwing initializer','int counter=1/divisor;for(counter=0;counter<3;counter++){use(counter);}'],
 ['initializer conversion','int counter=(int)1L;for(counter=0;counter<3;counter++){use(counter);}'],
 ['read before loop','int counter=1;use(counter);for(counter=0;counter<3;counter++){use(counter);}'],
 ['read after loop','int counter=1;for(counter=0;counter<3;counter++){use(counter);}use(counter);'],
 ['handler observation','int counter=1;try{for(counter=0;counter<3;counter++){use(counter);}}finally{use(counter);}'],
 ['self-reading header','int counter=1;for(counter=counter-1;counter<3;counter++){use(counter);}'],
 ['other counter phase','int counter;for(counter=0;counter<2;counter++){use(counter);}for(counter=0;counter<3;counter++){use(counter);}'],
 ['multiple initializers','int counter;int other;for(counter=0,other=1;counter<3;counter++){use(counter);}'],
 ['reference type','Integer counter;for(counter=0;counter<3;counter++){use(counter);}'],
 ['multiple declarators','int counter,other=effect();for(counter=0;counter<3;counter++){use(counter);}'],
 ['annotation','@A int counter;for(counter=0;counter<3;counter++){use(counter);}'],
 ['final binding','final int counter;for(counter=0;guard();){use(counter);}'],
 ['inline shadow','int counter;try{work();}catch(RuntimeException counter){use(counter);}for(counter=0;counter<3;counter++){use(counter);}'],
 ['capture','int counter;for(counter=0;counter<3;counter++){Runnable r=()->use(counter);}'],
 ['qualified spelling','int counter;object.counter=0;for(counter=0;counter<3;counter++){use(counter);}'],
 ['label spelling','int counter;counter: for(counter=0;counter<3;counter++){use(counter);break counter;}'],
 ['unbraced body','int counter;for(counter=0;counter<3;counter++)use(counter);'],
 ['comment','int counter;/* retain */for(counter=0;counter<3;counter++){use(counter);}'],
 ['unicode translation','int co\\u0075nter;for(counter=0;counter<3;counter++){use(counter);}'],
 ['malformed syntax','int counter;for('],
])test(`refuses ${name}`,()=>assert.deepEqual(recover(source),{source,declarationsMoved:0}));

test('reserved parameters and a large counter set have bounded, deterministic reconstruction',()=>{
 const source='int counter;for(counter=0;counter<3;counter++){use(counter);}';
 assert.deepEqual(recover(source,{reservedNames:['counter']}),{source,declarationsMoved:0});
 const many=Array.from({length:1000},(_,i)=>`int v${i};for(v${i}=0;v${i}<3;v${i}++){use(v${i});}`).join('\n');
 const result=recover(many);assert.equal(result.declarationsMoved,1000);assert.equal(result.source.match(/for\(int /g).length,1000);assert.deepEqual(recover(result.source),{source:result.source,declarationsMoved:0});
});

function run(command,args,cwd){const r=spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(r.status,0,r.stderr||r.error?.stack||r.stdout);return r.stdout.trim();}

test('native counter scopes preserve primitive types, loop transfers, effects, failures and monitors',()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'loop-declarations-native-'));
 try{
  const types=['boolean','byte','short','char','int','long','float','double'];
  const contexts=[loop=>loop,loop=>`try{${loop}}finally{cleanup();}`,loop=>`synchronized(monitor){${loop}}`,loop=>`try{throw marker;}catch(RuntimeException caught){${loop}}`];
  const methods=[],checks=[];
  for(const[typeIndex,type]of types.entries())for(const[contextIndex,wrap]of contexts.entries()){
   const condition=type==='boolean'?'!counter&&condition(0,limit)':'condition((int)counter,limit)';
   const initial=type==='boolean'?'initial(seed)%2==0':`(${type})initial(seed)`;
   const update=type==='boolean'?'counter=true':`counter=(${type})step((int)counter)`;
   const zero=type==='boolean'?'false':type==='char'?"'x'":type==='float'?'-0.0f':type==='double'?'-0.0d':type==='long'?'7L':'7';
   const value=type==='boolean'?'(counter?1:0)':'(int)counter';
   const loop=`Scan: for(counter=${initial};${condition};${update}){trace.append(tag(counter));body(${value});if(${value}==1)continue Scan;if(${value}==3)break Scan;}`;
   const before=`${type} counter=${zero};try{${wrap(loop)}}catch(Throwable failure){trace.append(failure==marker?"marker":failure.getClass().getName());}finally{trace.append('f').append(Thread.holdsLock(lock));}`;
   const next=recover(before);assert.equal(next.declarationsMoved,1,before);
   for(const[prefix,body]of[['old',before],['next',next.source]])methods.push(`static String ${prefix}${typeIndex}_${contextIndex}(int seed,int limit,int mode,boolean nullLock){currentMode=mode;trace.setLength(0);Object monitor=nullLock?null:lock;${body}return trace.toString();}`);
   checks.push(`{String expected=old${typeIndex}_${contextIndex}(seed,limit,mode,nullLock),actual=next${typeIndex}_${contextIndex}(seed,limit,mode,nullLock);if(!expected.equals(actual))throw new AssertionError("${typeIndex}/${contextIndex}:"+expected+" != "+actual);cases++;}`);
  }
  fs.writeFileSync(path.join(temporary,'LoopDeclarationNative.java'),`class LoopDeclarationNative{
   static int currentMode;static final Object lock=new Object();static final StringBuilder trace=new StringBuilder();static final RuntimeException marker=new IllegalArgumentException("marker");
   static int initial(int seed){trace.append('i').append(Thread.holdsLock(lock));if(currentMode==1)throw marker;return seed;}
   static boolean condition(int value,int limit){trace.append('c');if(currentMode==2)throw marker;return value<limit;}
   static int step(int value){trace.append('u');if(currentMode==3)throw marker;return value+1;}
   static void body(int value){trace.append('b').append(value);if(currentMode==4)throw marker;}
   static void cleanup(){trace.append('x').append(Thread.holdsLock(lock));if(currentMode==5)throw marker;}
   static String tag(boolean v){return "z"+v;}static String tag(byte v){return "b"+v;}static String tag(short v){return "s"+v;}static String tag(char v){return "c"+(int)v;}static String tag(int v){return "i"+v;}static String tag(long v){return "l"+v;}static String tag(float v){return "f"+Float.floatToRawIntBits(v);}static String tag(double v){return "d"+Double.doubleToRawLongBits(v);}
   ${methods.join('\n')}
   public static void main(String[] args){int cases=0;for(int seed:new int[]{-1,0,2})for(int limit:new int[]{0,1,4})for(int mode=0;mode<6;mode++)for(boolean nullLock:new boolean[]{false,true}){${checks.join('\n')}}System.out.println("cases:"+cases);}
  }`);
  run('javac',['LoopDeclarationNative.java'],temporary);assert.equal(run('java',['-cp',temporary,'LoopDeclarationNative'],temporary),'cases:3456');
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});

test('default decompilation localizes materialized loop counters and preserves an effectful earlier store',()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'loop-declarations-default-'));
 try{
  const original=path.join(temporary,'original'),next=path.join(temporary,'next');fs.mkdirSync(original);fs.mkdirSync(next);
  fs.writeFileSync(path.join(original,'LoopDeclarationDefault.java'),`class LoopDeclarationDefault{
   static int effects;static int effect(){effects++;return 17;}
   static int loops(int n){int i=effect();int sum=0;for(i=0;i<n;i++){sum+=i;}return sum;}
   static int nested(int n){int sum=0;for(int i=0;i<n;i++){for(int j=0;j<n;j++){sum+=i+j;}}return sum;}
   public static void main(String[]args){for(int n=0;n<5;n++)System.out.println(loops(n)+":"+nested(n)+":"+effects);}
  }`);
  run('javac',['--release','8','LoopDeclarationDefault.java'],original);
  const diagnostics=[],source=decompileClassFile(path.join(original,'LoopDeclarationDefault.class'),{diagnostics});assert.deepEqual(diagnostics,[]);assert.match(source,/for \(int /);assert.match(source,/effect\(\)/);
  fs.writeFileSync(path.join(next,'LoopDeclarationDefault.java'),source);run('javac',['--release','8','LoopDeclarationDefault.java'],next);
  assert.equal(run('java',['-cp',next,'LoopDeclarationDefault'],next),run('java',['-cp',original,'LoopDeclarationDefault'],original));
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
