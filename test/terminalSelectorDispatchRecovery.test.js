'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const {recoverScalarIfDispatches:recover}=require('../src/decompiler/javaAstEmitter');
const options={nestedRegions:true,opaqueControls:true};
const {tokenizeJava}=require('../src/java-frontend/lexer');
const lexical=source=>tokenizeJava(source).tokens.filter(t=>!['whitespace','comment','eof'].includes(t.kind)).map(t=>t.text).join(' ');
const ladder=action=>`if(selected==0){first();}else if(selected==1){second();}else if(selected==2){${action}}else fallback();`;

for(const action of[
 'selected++;work();', 'if(guard()){int temporary=selected;selected=temporary+7;work();}',
 'try{selected=next();work();}finally{cleanup();}',
 'try{while(more()){selected++;}}finally{cleanup();}',
 'switch(other()){case 0:selected=7;break;default:work();}',
 'switch(other()){default:if(stop())break;return done();}',
 'switch(other()){default:try{if(stop())break;return done();}finally{cleanup();}}',
 'switch(other()){default:try{if(stop())break;return done();}finally{return done();}}',
])test('retains a terminal action and its selector writes: '+action,()=>{
 const source='int selected=read();Frame:{'+ladder(action)+'}observe(selected);';
 const result=recover(source,options);assert.equal(result.dispatchesRecovered,1);assert.ok(lexical(result.source).includes(lexical(action)));assert.ok(result.source.endsWith('observe(selected);'));assert.equal(recover(result.source,options).dispatchesRecovered,0);
});

for(const action of ['selected++;','selected=next();','if(guard()){selected=2;}','try{work();}finally{selected=2;}'])test('refuses a write before a later classification: '+action,()=>{
 const source='int selected=read();Frame:{if(selected==0){'+action+'}if(selected==1){second();}if(selected==2){third();}}';
 assert.equal(recover(source,options).source,source);
});

test('direct declarations keep their existing scope rather than becoming case siblings',()=>{
 const source='int selected=read();Frame:{if(selected==0){int value=1;use(value);}else if(selected==1){int value=2;use(value);}else if(selected==2){third();}}';
 assert.equal(recover(source,options).source,source);
});

test('native selector reuse and conditional switch exits preserve effects, values and protected completion',()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-selector-native-'));
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{cwd:temporary,encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(r.status,0,r.stderr||r.error?.stack||r.stdout);return r.stdout.trim();};
 const actions=[
  'if(gate()){int temporary=selected;selected=temporary+7;store(20);}else store(21);',
  'try{selected=next(selected);store(22);}finally{store(23);if(mode==3)continue Outer;}',
  'if(gate()){selected++;store(24);break Frame;}selected=25;store(25);',
 ];
 const fallbacks=[
  'switch(other()){case 0:selected+=11;if(gate())break;store(30);break;default:store(31);}',
  'switch(other()){default:try{selected=next(selected);if(gate())break;store(32);return snapshot()+selected;}finally{store(33);if(mode==3)return snapshot()+selected;}}',
  'switch(other()){default:try{selected=next(selected);if(gate())break;return snapshot()+selected;}finally{store(34);return snapshot()+selected;}}',
  'synchronized(lock){switch(other()){default:if(gate()){selected+=12;break;}selected=next(selected);store(35);}}',
  'switch(other()){case 0:try{if(gate()){selected+=13;break;}store(36);}finally{store(37);}break;default:try{selected=next(selected);break;}finally{store(38);if(mode==3)throw OVERRIDE;}}',
 ];
 try{
  let methods='';
  for(const[variant,fallback]of fallbacks.entries()){
   const prefix='int selected=select(input);Outer:for(int round=0;round<2;round++){Frame:{',suffix='}store(90+selected);}return snapshot()+selected;';
   const old=prefix+`if(selected==0){${actions[0]}}else if(selected==1){${actions[1]}}else if(selected==2){${actions[2]}}else{${fallback}}`+suffix;
   const result=recover(old,options);assert.equal(result.dispatchesRecovered,1,'variant '+variant);
   // An independently specified direct dispatch chooses the same literal cases.
   // The unchanged action bodies isolate classification/transfer semantics.
   const oracle=prefix+'switch(selected){'+actions.map((action,i)=>`case ${i}:{${action}}break;`).join('')+`default:{${fallback}}${variant===2?'':'break;'}`+'}'+suffix;
   for(const[name,body]of[['old',old],['next',result.source],['oracle',oracle]])methods+=`static String ${name}${variant}(int input){${body}}\n`;
  }
  fs.writeFileSync(path.join(temporary,'TerminalSelectorNative.java'),`class TerminalSelectorNative{
   static int mode,value,count,fault;static StringBuilder trace;static Object lock;static int[] array,alias;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalArgumentException();
   static void event(int n){value=Integer.rotateLeft(value^n,n&31);trace.append(n).append(lock!=null&&Thread.holdsLock(lock)?'L':'U');if(count++==fault)throw FAILURE;}
   static void store(int n){event(n);alias[count&3]=value;}static int select(int n){event(1);return n;}static int next(int n){event(2);return n+7;}static int other(){event(3);return mode&1;}static Boolean gate(){event(4);return mode==2?null:mode==1;}
   static String snapshot(){return value+":"+count+":"+trace+":"+java.util.Arrays.toString(array)+":"+(array==alias);}
   ${methods}
   static String take(int variant,int kind,int input,int m,int fail,int seed,boolean nullLock){mode=m;value=seed;count=0;fault=fail;trace=new StringBuilder();lock=nullLock?null:new Object();array=new int[]{seed,seed,seed,seed};alias=array;String result;try{switch(variant){${fallbacks.map((_,i)=>`case ${i}:result=kind==0?old${i}(input):kind==1?next${i}(input):oracle${i}(input);break;`).join('')}default:throw new AssertionError();}}catch(Throwable failure){if(failure==FAILURE)result="failure";else if(failure==OVERRIDE)result="override";else if(failure instanceof NullPointerException)result="null";else throw new AssertionError(failure);}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+"/"+snapshot();}
   public static void main(String[]args){int cases=0;for(int variant=0;variant<${fallbacks.length};variant++)for(int input:new int[]{Integer.MIN_VALUE,-1,0,1,2,3,Integer.MAX_VALUE})for(int m=0;m<4;m++)for(int fail=-1;fail<16;fail++)for(int seed:new int[]{Integer.MIN_VALUE,0,Integer.MAX_VALUE})for(boolean nullLock:new boolean[]{false,true}){String expected=take(variant,2,input,m,fail,seed,nullLock);for(int kind=0;kind<2;kind++){String actual=take(variant,kind,input,m,fail,seed,nullLock);if(!expected.equals(actual))throw new AssertionError(variant+":"+input+":"+m+":"+fail+":"+expected+" != "+actual);}cases++;}System.out.println(cases);}
  }`);
  run('javac',['--release','8','TerminalSelectorNative.java']);assert.equal(run('java',['-Xverify:all','-Xmx128m','-cp',temporary,'TerminalSelectorNative']),'14280');
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
