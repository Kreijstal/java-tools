'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');const {spawnSync}=require('child_process');
const {localizeLocalInitializations:recover}=require('../src/decompiler/javaAstEmitter');
const {decompileClassFile}=require('../src/decompiler/cfr');

for(const[name,wrap]of[
 ['plain',s=>s],['conditional',s=>`if(flag){${s}}`],['loop',s=>`while(again()){if(skip())continue;${s}}`],
 ['for body',s=>`for(int i=0;i<3;i++){${s}}`],['protected',s=>`try{${s}}finally{cleanup();}`],
 ['handler',s=>`try{work();}catch(RuntimeException failure){${s}}`],
 ['finally',s=>`try{work();}finally{${s}}`],['monitor',s=>`synchronized(lock){${s}}`],
])test(`merges a first standalone store within its ${name} block`,()=>{
 const source='Object value=null;'+wrap('value = allocate();use(value);value=next();use(value);');
 const result=recover(source);assert.equal(result.declarationsMerged,1);
 assert.equal(result.source,wrap('Object value = allocate();use(value);value=next();use(value);'));
 assert.deepEqual(recover(result.source),{source:result.source,declarationsMerged:0});
});

test('retains exact declared types and first-store RHS bytes, removing only inert defaults',()=>{
 for(const[type,initial,rhs]of[
  ['boolean','false','predicate()'],['byte','0','(byte)effect()'],['short','-1','(short)effect()'],['char',"'x'",'(char)effect()'],
  ['int','+1','a / divisor'],['long','7L','effect()'],['float','-0.0f','flag ? -0.0f : Float.NaN'],['double','-0.0d','effect()'],
  ['Object','null','flag ? new Object() : boxed'],['Throwable','null','new Exception()'],['Integer','null','box()'],
  ['int[]','null','new int[size()]'],['java.util.List<String>','null','new java.util.ArrayList<>()'],
 ]){
  const source=`${type} value=${initial};\nvalue = ${rhs};use(value);`;
  assert.deepEqual(recover(source),{source:`${type} value = ${rhs};use(value);`,declarationsMerged:1});
 }
});

test('keeps dependency stores in order and narrows independent block lifetimes',()=>{
 const source='int first;\nObject second;\nfirst=effect();second=box(first);use(second);{int third;third=next();use(third);}';
 const result=recover(source);assert.equal(result.declarationsMerged,3);
 assert.equal(result.source,'int first=effect();Object second=box(first);use(second);{int third=next();use(third);}');
});

for(const[name,source]of[
 ['effectful default','int value=effect();value=next();use(value);'],
 ['throwing default','int value=1/divisor;value=next();use(value);'],
 ['default cast','int value=(int)1L;value=next();use(value);'],
 ['boxed default','Integer value=1;value=next();use(value);'],
 ['string default','String value="x";value=next();use(value);'],
 ['receiver default','Object value=this;value=next();use(value);'],
 ['allocated default','Object value=new Object();value=next();use(value);'],
 ['RHS self read','int value=1;value=value+1;use(value);'],
 ['RHS nested self store','int value=1;value=(value=next());use(value);'],
 ['earlier read','int value=1;use(value);value=next();use(value);'],
 ['sibling observation','int value=1;if(flag){value=next();use(value);}else{use(value);}'],
 ['join observation','int value=1;if(flag){value=next();}use(value);'],
 ['handler observation','int value=1;try{value=next();use(value);}catch(Exception failure){use(value);}'],
 ['finally observation','int value=1;try{value=next();}finally{use(value);}'],
 ['loop carried condition','int value=1;while(value<3){value=next();use(value);}'],
 ['loop carried update','int value=1;for(int i=0;i<3;use(value)){value=next();use(value);}'],
 ['loop later read','int value=1;while(again()){value=next();use(value);}use(value);'],
 ['loop initializer store','int value;for(value=0;value<3;value++){use(value);}'],
 ['unbraced store','int value;if(flag)value=next();'],
 ['labeled store','int value;Store:value=next();use(value);'],
 ['parenthesized store','int value;(value)=next();use(value);'],
 ['compound store','int value=1;value+=next();use(value);'],
 ['qualified target','int value;object.value=next();use(value);'],
 ['array target','int[] value;value[0]=next();use(value);'],
 ['multi declarator','int value,other;value=next();use(value);'],
 ['annotation','@A int value;value=next();use(value);'],
 ['final binding','final int value;value=next();use(value);'],
 ['after-name dimensions','int value[];value=next();use(value);'],
 ['inferred type','var value=null;value=next();use(value);'],
 ['shadow','int value;try{work();}catch(Exception value){use(value);}value=next();use(value);'],
 ['lambda capture','int value;value=next();run(()->use(value));'],
 ['method reference','Object value;value=next();run(value::toString);'],
 ['anonymous class','Object value;value=next();run(new Runnable(){public void run(){use(value);}});'],
 ['local class','int value;value=next();class Local{void run(){use(value);}}'],
 ['method name ambiguity','int value;value=next();value();use(value);'],
 ['field name ambiguity','int value;value=next();use(object.value);use(value);'],
 ['label ambiguity','int value;value=next();value:while(flag){use(value);break value;}'],
 ['comment offsets','int value;/* keep */value=next();use(value);'],
 ['unicode translation','int val\\u0075e;value=next();use(value);'],
 ['malformed syntax','int value;value=('],
])test(`refuses ${name}`,()=>assert.deepEqual(recover(source),{source,declarationsMerged:0}));

test('reserved names and one thousand independent locals remain deterministic',()=>{
 const source='int value;value=next();use(value);';
 assert.deepEqual(recover(source,{reservedNames:['value']}),{source,declarationsMerged:0});
 const many=Array.from({length:1000},(_,i)=>`int v${i};v${i}=next();use(v${i});`).join('\n');
 const result=recover(many);assert.equal(result.declarationsMerged,1000);
 assert.equal(result.source.match(/int v\d+=next/g).length,1000);
 assert.deepEqual(recover(result.source),{source:result.source,declarationsMerged:0});
});

function run(command,args,cwd){const r=spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(r.status,0,r.stderr||r.error?.stack||r.stdout);return r.stdout.trim();}

test('native scopes preserve overload types, reference identity, throwing stores, transfers and monitors',()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'local-initializations-native-'));
 try{
  const types=[['boolean','false','create(seed)%2==0'],['byte','0','(byte)create(seed)'],['short','0','(short)create(seed)'],['char',"'x'",'(char)create(seed)'],['int','0','create(seed)'],['long','0L','create(seed)'],['float','-0.0f','Float.intBitsToFloat(create(seed))'],['double','-0.0d','Double.longBitsToDouble(create(seed))'],['Object','null','reference(seed)'],['Throwable','null','exception(seed)'],['Integer','null','boxed(seed)'],['int[]','null','array(seed)']];
  const contexts=[s=>s,s=>`if(seed!=0){${s}}`,s=>`try{${s}}finally{cleanup();}`,s=>`synchronized(monitor){${s}}`,s=>`try{throw marker;}catch(RuntimeException caught){${s}}`,s=>`try{trace.append('p');}finally{${s}}`,s=>`for(int i=0;i<3;i++){if(i==seed)continue;${s}if(i==1)break;}`];
  const methods=[],checks=[];
  for(const[typeIndex,[type,zero,rhs]]of types.entries())for(const[contextIndex,wrap]of contexts.entries()){
   const before=`${type} value=${zero};try{${wrap(`value=${rhs};trace.append(tag(value));consume(value);`)}}catch(Throwable failure){trace.append(failure==marker?"marker":failure.getClass().getName());}finally{trace.append('f').append(Thread.holdsLock(lock));}`;
   const next=recover(before);assert.equal(next.declarationsMerged,1,before);
   for(const[prefix,body]of[['old',before],['next',next.source]])methods.push(`static String ${prefix}${typeIndex}_${contextIndex}(int seed,int mode,boolean nullLock){currentMode=mode;trace.setLength(0);Object monitor=nullLock?null:lock;${body}return trace.toString();}`);
   checks.push(`{String expected=old${typeIndex}_${contextIndex}(seed,mode,nullLock),actual=next${typeIndex}_${contextIndex}(seed,mode,nullLock);if(!expected.equals(actual))throw new AssertionError("${typeIndex}/${contextIndex}:"+expected+" != "+actual);cases++;}`);
  }
  fs.writeFileSync(path.join(temporary,'LocalInitializationNative.java'),`class LocalInitializationNative{
   static int currentMode;static final Object lock=new Object(), shared=new Object();static final int[] sharedArray={7};static final Integer sharedBox=Integer.valueOf(1000);static final StringBuilder trace=new StringBuilder();static final RuntimeException marker=new IllegalArgumentException("marker");
   static int create(int seed){trace.append('i').append(Thread.holdsLock(lock));if(currentMode==1)throw marker;return seed;}
   static Object reference(int seed){create(seed);return seed==0?null:shared;}static Throwable exception(int seed){create(seed);return seed==0?null:marker;}static Integer boxed(int seed){create(seed);return seed==0?null:sharedBox;}static int[] array(int seed){create(seed);return seed==0?null:sharedArray;}
   static void consume(Object value){trace.append('b').append(value==shared||value==sharedArray||value==sharedBox||value==marker);if(currentMode==2)throw marker;}
   static void cleanup(){trace.append('x').append(Thread.holdsLock(lock));if(currentMode==3)throw marker;}
   static String tag(boolean v){return "z"+v;}static String tag(byte v){return "b"+v;}static String tag(short v){return "s"+v;}static String tag(char v){return "c"+(int)v;}static String tag(int v){return "i"+v;}static String tag(long v){return "l"+v;}static String tag(float v){return "f"+Float.floatToRawIntBits(v);}static String tag(double v){return "d"+Double.doubleToRawLongBits(v);}static String tag(Object v){return "O"+(v==null);}static String tag(Throwable v){return "T"+(v==null);}static String tag(Integer v){return "I"+(v==null);}static String tag(int[] v){return "A"+(v==null);}
   ${methods.join('\n')}
   public static void main(String[]args){int cases=0;for(int seed:new int[]{-1,0,1})for(int mode=0;mode<4;mode++)for(boolean nullLock:new boolean[]{false,true}){${checks.join('\n')}}System.out.println("cases:"+cases);}
  }`);
  run('javac',['LocalInitializationNative.java'],temporary);assert.equal(run('java',['-cp',temporary,'LocalInitializationNative'],temporary),'cases:2016');
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});

test('default decompilation combines initialization and compiles without flags',()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'local-initializations-default-'));
 try{
  const original=path.join(temporary,'original'),next=path.join(temporary,'next');fs.mkdirSync(original);fs.mkdirSync(next);
  fs.writeFileSync(path.join(original,'LocalInitializationDefault.java'),`class LocalInitializationDefault{
   static int effects;static int effect(int n){effects++;if(n==2)throw new IllegalArgumentException();return n+1;}
   static int calculate(int n){int result;try{int value=effect(n);result=value*3;}catch(IllegalArgumentException failure){result=-1;}return result;}
   static Object identity(Object x){Object value=x;return value;}
   public static void main(String[]args){for(int n=0;n<5;n++)System.out.println(calculate(n)+":"+effects+":"+(identity(args)==args));}
  }`);
  run('javac',['--release','8','LocalInitializationDefault.java'],original);
  const diagnostics=[],source=decompileClassFile(path.join(original,'LocalInitializationDefault.class'),{diagnostics});assert.deepEqual(diagnostics,[]);assert.match(source,/int \w+ = LocalInitializationDefault\.effect\(/);
  fs.writeFileSync(path.join(next,'LocalInitializationDefault.java'),source);run('javac',['--release','8','LocalInitializationDefault.java'],next);
  assert.equal(run('java',['-cp',next,'LocalInitializationDefault'],next),run('java',['-cp',original,'LocalInitializationDefault'],original));
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
