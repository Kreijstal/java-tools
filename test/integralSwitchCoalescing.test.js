'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const {recoverScalarIfDispatches:recover,simplifyBodyDecisions:finish}=require('../src/decompiler/javaAstEmitter');
const options={nestedRegions:true,opaqueControls:true};
const inner='switch(selected){case 1:first();break;default:rest();}';
for(const[source,kind]of[
 ['int selected=read();if(selected!=0){'+inner+'}else{zero();}','guarded-switch'],
 ['int selected=read();if(!(selected!=0)){zero();}else{'+inner+'}','guarded-switch'],
 ['int selected=read();if(0==selected){int local=prepare();use(local);}else{'+inner+'}','guarded-switch'],
 ['int selected=read();if(selected!=0){'+inner+'}else if(guard()){zero();}','guarded-switch'],
 ['int selected=read();switch(selected){case 1:first();break;default:switch(selected){case 2:second();break;default:rest();}break;case 3:last();break;}','default-switch'],
 ['int selected=read();switch(selected){default:switch(selected){case 2:{int local=prepare();use(local);}break;default:rest();}break;}','default-switch'],
 ['int selected=read();switch(selected){case 1:first();break;default:switch(selected){case 2:second();}break;case 3:last();break;}','default-switch'],
])test('coalesces a transparent '+kind+' without copying work',()=>{
 const result=recover(source,{...options,retainDiagnostics:true});assert.equal(result.dispatchesRecovered,1);assert.equal(result.diagnostics.kind,kind);
 for(const call of ['read()','first()','rest()','zero()','prepare()','use(local)','second()','last()'])assert.equal(result.source.split(call).length,source.split(call).length,call);
 assert.equal(recover(result.source,options).dispatchesRecovered,0);
});

test('scoped actions retain abrupt completion, loop exits and protected cleanup',()=>{
 for(const action of ['return done();','try{zero();}finally{return done();}','synchronized(lock){zero();}',
  'try{zero();}finally{cleanup();}','Done:{return done();}',
  'Done:{if(stop())break Done;return done();}','Done:{try{break Done;}finally{return done();}}',
  'while(more()){if(stop())break;zero();}',
  'for(Object value:items){use(value);}','switch(other()){default:if(stop())break;return done();}']){
  const source='int selected=read();if(selected!=0){'+inner+'}else{'+action+'}';
  const result=recover(source,options);assert.equal(result.dispatchesRecovered,1,action);assert.ok(result.source.includes(action));
 }
 for(const action of ['break Outer;','continue Outer;','continue;']){
  const source='int selected=read();Outer:while(more()){if(selected!=0){'+inner+'}else{'+action+'}}';
  const result=recover(source,options);assert.equal(result.dispatchesRecovered,1);assert.ok(result.source.includes(action));
 }
});

for(const[name,source]of[
 ['overlapping guard case','int selected=read();if(selected!=0){switch(selected){case 0:unreachable();break;default:rest();}}else{zero();}'],
 ['intervening work','int selected=read();if(selected!=0){touch();'+inner+'}else{zero();}'],
 ['switch on equality arm','int selected=read();if(selected==0){'+inner+'}else{rest();}'],
 ['unknown selector','if(selected!=0){'+inner+'}else{zero();}'],
 ['boxed selector','Integer selected=read();if(selected!=0){'+inner+'}else{zero();}'],
 ['field selector','if(object.selected!=0){switch(object.selected){default:rest();}}else{zero();}'],
 ['effectful selector','if(read()!=0){switch(read()){default:rest();}}else{zero();}'],
 ['captured anonymous field','int selected=read();if(selected!=0){'+inner+'}else{use(new Object(){int captured=selected;});}'],
 ['unknown loop completion','int selected=read();if(selected!=0){'+inner+'}else{while(true){zero();}}'],
 ['external bare break','int selected=read();while(more()){if(selected!=0){'+inner+'}else{break;}}'],
 ['overlapping nested cases','int selected=read();switch(selected){case 1:first();break;default:switch(selected){case 1:unreachable();break;default:rest();}break;}'],
 ['incoming default fallthrough','int selected=read();switch(selected){case 1:first();default:switch(selected){case 2:second();break;default:rest();}break;}'],
 ['default aliases','int selected=read();switch(selected){case 1:default:switch(selected){case 2:second();break;default:rest();}break;}'],
 ['nontransparent default tail','int selected=read();switch(selected){default:switch(selected){case 2:second();break;default:rest();}after();break;}'],
 ['case binding widening','int selected=read();switch(selected){default:switch(selected){case 2:int local=1;use(local);break;default:rest();}break;}'],
 ['unknown case identity','int selected=read();switch(selected){case NAMED:first();break;default:switch(selected){case 2:second();break;default:rest();}break;}'],
 ['different inner selector','int selected=read();int other=read();switch(selected){default:switch(other){case 2:second();break;default:rest();}break;}'],
 ['unknown last-group completion','int selected=read();switch(selected){default:switch(selected){default:while(true){work();}}break;}'],
 ['comments','int selected=read();if(selected!=0){'+inner+'}else{/* keep */zero();}'],
])test('refuses '+name,()=>assert.equal(recover(source,options).source,source));

test('removed switch boundaries do not leave whitespace-only lines',()=>{
 for(const content of ['case 2: second(); break; default: rest();','']){
  const source='int selected=read();\nswitch(selected){\n  case 1:first();break;\n  default:\n    switch(selected){\n      '+content+'\n    }\n    break;\n  case 3:last();break;\n}';
  const result=finish(source);assert.equal(result.dispatchesRecovered,1);assert.doesNotMatch(result.source,/^[ \t]+$/m);assert.equal(finish(result.source).source,result.source);
 }
});

test('the default decision policy combines both layers without application flags',()=>{
 const source='int selected=read();if(selected!=0){switch(selected){case 1:first();break;default:switch(selected){case 2:second();break;default:rest();}break;}}else{zero();}';
 const result=finish(source);assert.equal(result.dispatchesRecovered,2);assert.equal((result.source.match(/switch\s*\(/g)||[]).length,1);assert.match(result.source,/case 0:/);assert.equal(finish(result.source).source,result.source);
 const body=[source];require('../src/decompiler/cfr')._internals.shareExistingExitTails(body);assert.equal((body.join('\n').match(/switch\s*\(/g)||[]).length,1);
});

test('native coalescing preserves conditional fallthrough, scopes, selector reuse and pending completion',()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'switch-coalescing-native-'));
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{cwd:temporary,encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(r.status,0,r.stderr||r.error?.stack||r.stdout);return r.stdout.trim();};
 const guardActions=[
  'if(flag()){int local=selected;selected=local+7;store(20);}',
  'try{selected=next(selected);store(21);if(mode==3)continue Loop;}finally{store(22);}',
  'synchronized(lock){selected=next(selected);store(23);}',
  'try{selected=next(selected);return snapshot()+selected;}finally{store(24);}',
  'switch(other()){default:try{if(flag())break;selected=next(selected);return snapshot()+selected;}finally{store(25);}}',
 ];
 const defaultActions=[
  'store(42);',
  'if(flag()){selected=next(selected);break;}store(43);',
  'try{selected=next(selected);if(flag())break;return snapshot()+selected;}finally{store(44);}',
  'synchronized(lock){if(flag()){selected+=15;break;}selected=next(selected);store(45);}',
  'try{while(more()){selected++;store(46);if(stop())break;}}finally{store(47);}',
  'Done:{try{selected=next(selected);return snapshot()+selected;}finally{store(48);}}',
  'Done:{try{break Done;}finally{store(49);return snapshot()+selected;}}',
 ];
 try{
  let methods='';
  for(let model=0;model<12;model++){
   const prefix='int selected=select(input);Loop:for(int round=0;round<2;round++){remaining=0;',suffix='store(90+selected);}return snapshot()+selected;';
   let original,oracle;
   if(model<5){
    const zero=guardActions[model],one='selected+=11;store(31);if(mode==3)break;',two='store(32);';
    const sw=`switch(selected){case 1:${one}case 2:${two}break;default:store(33);}`;
    original=prefix+`if(selected!=0){${sw}}else{${zero}}`+suffix;
    oracle=prefix+`switch(selected){case 0:{${zero}}${model===3?'':'break;'}case 1:${one}case 2:${two}break;default:store(33);break;}`+suffix;
   }else{
    const tail=defaultActions[model-5],one='store(34);',two='selected+=12;store(35);if(mode==3)break;',three='store(36);',four='store(37);';
    original=prefix+`switch(selected){case 1:${one}break;default:switch(selected){case 2:${two}case 3:${three}break;default:${tail}}break;case 4:${four}break;}`+suffix;
    oracle=prefix+`switch(selected){case 1:${one}break;case 2:${two}case 3:${three}break;default:${tail}${[7,10,11].includes(model)?'':'break;'}case 4:${four}break;}`+suffix;
   }
   const result=recover(original,options);assert.equal(result.dispatchesRecovered,1,'model '+model);
   assert.equal(recover(result.source,options).dispatchesRecovered,0);
   for(const[name,body]of[['old',original],['next',result.source],['oracle',oracle]])methods+=`static String ${name}${model}(int input){${body}}\n`;
  }
  fs.writeFileSync(path.join(temporary,'CoalescingNative.java'),`class CoalescingNative{
   static int mode,value,count,fault,remaining;static Object lock;static StringBuilder trace;static int[] array,alias;static final RuntimeException FAILURE=new IllegalStateException();
   static void event(int n){value=Integer.rotateLeft(value^n,n&31);trace.append(n).append(lock!=null&&Thread.holdsLock(lock)?'L':'U');if(count++==fault)throw FAILURE;}
   static void store(int n){event(n);alias[count&3]=value;}static int select(int n){event(1);return n;}static int next(int n){event(2);return n+7;}static int other(){event(3);return mode&1;}static Boolean flag(){event(4);return mode==2?null:mode==1;}static boolean more(){event(5);return remaining++<2;}static boolean stop(){event(6);return mode==1;}
   static String snapshot(){return value+":"+count+":"+trace+":"+java.util.Arrays.toString(array)+":"+(array==alias);}
   ${methods}
   static String take(int model,int kind,int input,int m,int fail,int seed,boolean nullLock){mode=m;value=seed;count=0;fault=fail;trace=new StringBuilder();lock=nullLock?null:new Object();array=new int[]{seed,seed,seed,seed};alias=array;String result;try{switch(model){${Array.from({length:12},(_,i)=>`case ${i}:result=kind==0?old${i}(input):kind==1?next${i}(input):oracle${i}(input);break;`).join('')}default:throw new AssertionError();}}catch(Throwable failure){if(failure==FAILURE)result="failure";else if(failure instanceof NullPointerException)result="null";else throw new AssertionError(failure);}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+"/"+snapshot();}
   public static void main(String[]args){int cases=0;for(int model=0;model<12;model++)for(int input:new int[]{Integer.MIN_VALUE,-1,0,1,2,3,4,Integer.MAX_VALUE})for(int m=0;m<4;m++)for(int fail=-1;fail<13;fail++)for(int seed:new int[]{Integer.MIN_VALUE,0,Integer.MAX_VALUE})for(boolean nullLock:new boolean[]{false,true}){String expected=take(model,2,input,m,fail,seed,nullLock);for(int kind=0;kind<2;kind++){String actual=take(model,kind,input,m,fail,seed,nullLock);if(!expected.equals(actual))throw new AssertionError(model+":"+input+":"+m+":"+fail+":"+expected+" != "+actual);}cases++;}System.out.println(cases);}
  }`);
  run('javac',['--release','8','CoalescingNative.java']);assert.equal(run('java',['-Xverify:all','-Xmx128m','-cp',temporary,'CoalescingNative']),'32256');
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
