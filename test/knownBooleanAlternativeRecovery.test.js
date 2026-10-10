'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {foldKnownBooleanAlternatives:fold}=require('../src/decompiler/javaAstEmitter');
test('true initialization and a dominating true guard produce exact else work',()=>{
 for(const source of [
  'boolean flag=true;if(test()){effect();flag=false;}if(flag){work();}',
  'boolean flag=true;if(enter()){if(test()){effect();flag=false;}if((flag)){work();}}',
  'boolean flag=false;flag=read();if(flag){if(test()){effect();flag=false;}if(flag){work();}}',
  'while(next()){boolean flag=true;if(test()){effect();flag=false;}if(flag){work();}}',
  'try{boolean flag=true;if(test()){effect();flag=false;}if(flag){work();}}finally{cleanup();}',
 ]){
  const result=fold(source,{retainDiagnostics:true});assert.equal(result.alternativesRecovered,1,source);
  for(const text of ['test()','effect()','flag=false','work()'])assert.equal(result.source.split(text).length-1,source.split(text).length-1,text);
  let expected=source;for(const edit of result.diagnostics.edits)expected=expected.slice(0,edit.start)+edit.text+expected.slice(edit.end);assert.equal(result.source,expected);assert.equal(fold(result.source).alternativesRecovered,0);
 }
});
test('unproven entry, compound initialization and conditional writes cannot select an alternative',()=>{
 for(const source of [
  'boolean flag=false;if(test()){effect();flag=false;}if(flag){work();}',
  'boolean flag=true;change();if(reset())flag=false;if(test()){effect();flag=false;}if(flag){work();}',
  'boolean flag=true,other=(flag=false);if(test()){effect();flag=false;}if(flag){work();}',
  'boolean flag=true;while(next()){if(test()){effect();flag=false;}if(flag){work();}}',
  'boolean flag=true;if((flag=false)||test()){effect();flag=false;}if(flag){work();}',
  'boolean flag=true;if(test()){flag=true;effect();flag=false;}if(flag){work();}',
  'Boolean flag=true;if(test()){effect();flag=false;}if(flag){work();}',
  'boolean flag=true;if(test()){effect();flag=false;}between();if(flag){work();}',
  'boolean flag=true;if(test()){effect();flag=false;}else other();if(flag){work();}',
  'boolean flag=true;if(test()){effect();flag=false;}if(flag){work();}else other();',
  'boolean flag=true;try{if(test()){effect();flag=false;}if(flag){work();}}finally{cleanup();}',
  '{boolean flag=true;}boolean flag=true;if(test()){effect();flag=false;}if(flag){work();}',
  'boolean flag=true;if(test()){effect();flag=false;}if(flag){work();}Runnable r=()->work();',
 ])assert.equal(fold(source).source,source,source);
 const source='boolean flag=true;if(test()){effect();flag=false;}if(flag){work();}';
 assert.equal(fold(source,{reservedNames:['flag']}).source,source);assert.equal(fold(source,{retainDiagnostics:1}).source,source);assert.equal(fold(source,{reservedNames:null}).source,source);
});
test('complete scope, later stores and protected work remain verbatim',()=>{
 const source='boolean flag=true;if(test()){try{effect();}finally{cleanup();}flag=false;}if(flag){int x=read();use(x);flag=again();}if(flag){tail();}';
 const result=fold(source);assert.equal(result.alternativesRecovered,1);assert.ok(result.source.includes('else {int x=read();use(x);flag=again();}if(flag){tail();}'));assert.ok(result.source.includes('try{effect();}finally{cleanup();}flag=false;'));
});
test('native alternatives match independent work oracles through callbacks failures and protection',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'known-boolean-native-'));
 const run=(command,args)=>{const outputs=['out','err'].map(n=>path.join(directory,n)),fds=outputs.map(f=>fs.openSync(f,'w'));try{const result=spawnSync(command,args,{stdio:['ignore',...fds]});if(result.error)throw result.error;assert.equal(result.status,0,fs.readFileSync(outputs[1],'utf8'));return fs.readFileSync(outputs[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const wrappers=[s=>s,s=>`try{${s}}finally{event(9);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){${s}}`,s=>`try{${s}}catch(IllegalStateException e){event(10);if(e!=FAILURE)throw e;}finally{event(9);}`];
 const work='event(7);if(choice(first,2)){event(1);state=SECOND;value+=seed;flag=false;}if(flag){event(3);value^=seed;alias=saved==state;flag=choice(again,4);}chosen=flag;';
 const bodies=[`Object saved=state;boolean flag=true;${work}if(flag){event(5);value+=extraFlag;}event(6);`,
  `Object saved=state;boolean flag=false;flag=choice(outer,0);if(flag){${work}}if(flag){event(5);value+=extraFlag;}event(6);`];
 const oracles=['Object saved=state;chosen=oracleWork(first,again,seed,saved);if(chosen){event(5);value+=extraFlag;}event(6);',
  'Object saved=state;if(oracleChoice(outer,0))chosen=oracleWork(first,again,seed,saved);if(chosen){event(5);value+=extraFlag;}event(6);'];
 try{
  let methods='',models=0;for(let kind=0;kind<bodies.length;kind++)for(const wrap of wrappers){const before=wrap(bodies[kind])+'return snapshot();',next=fold(before);assert.equal(next.alternativesRecovered,1,before);for(const[name,source]of [['old',before],['next',next.source],['oracle',wrap(oracles[kind])+'return snapshot();']])methods+=`static String ${name}${models}(Boolean outer,Boolean first,Boolean again,int seed,int extraFlag,int mode){${source}}\n`;models++;}
  const java=`public class AlternativeOracle{
   static int value,count,failAt;static boolean chosen,alias;static Object state,lock;static StringBuilder trace;
   static final Object INITIAL=new Object(),SECOND=new Object();static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();
   static void event(int n){trace.append(n).append(Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}
   static boolean choice(Boolean b,int n){event(n);return b.booleanValue();}static boolean oracleChoice(Boolean b,int n){event(n);if(b==null)throw new NullPointerException();return b==Boolean.TRUE;}
   static boolean oracleWork(Boolean first,Boolean again,int seed,Object saved){event(7);if(oracleChoice(first,2)){event(1);state=SECOND;value+=seed;return false;}event(3);value^=seed;alias=saved==state;return oracleChoice(again,4);}
   static String snapshot(){return value+":"+count+":"+chosen+":"+alias+":"+(state==INITIAL)+":"+trace;}
   ${methods}
   static String take(int model,int variant,Boolean outer,Boolean first,Boolean again,int seed,int extraFlag,int mode){value=seed;count=0;chosen=false;alias=false;state=INITIAL;lock=new Object();trace=new StringBuilder();String result;try{switch(model){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(outer,first,again,seed,extraFlag,mode):variant==1?next${i}(outer,first,again,seed,extraFlag,mode):oracle${i}(outer,first,again,seed,extraFlag,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("lock leaked");return result+":"+snapshot();}
   public static void main(String[]args){int cases=0;for(int model=0;model<${models};model++)for(Boolean outer:new Boolean[]{false,true,null})for(Boolean first:new Boolean[]{false,true,null})for(Boolean again:new Boolean[]{false,true,null})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int extraFlag:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int mode=0;mode<3;mode++)for(int failure=-1;failure<19;failure++){failAt=failure;String expected=take(model,2,outer,first,again,seed,extraFlag,mode);for(int variant=0;variant<2;variant++){String actual=take(model,variant,outer,first,again,seed,extraFlag,mode);if(!actual.equals(expected))throw new AssertionError(model+":"+outer+":"+first+":"+again+":"+seed+":"+extraFlag+":"+mode+":"+failure+":"+expected+":"+actual);}cases++;}System.out.println(cases);}}
  `;const file=path.join(directory,'AlternativeOracle.java');fs.writeFileSync(file,java);run('javac',['--release','8','-d',directory,file]);assert.equal(run('java',['-Xmx128m','-cp',directory,'AlternativeOracle']),'324000');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
