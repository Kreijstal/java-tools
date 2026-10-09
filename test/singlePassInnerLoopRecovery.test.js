'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{foldSinglePassInnerLoops:fold}=require('../src/decompiler/javaAstEmitter');
const{shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;

test('the final emitter removes single-pass inner loops and redirects their exits to the outer iteration',()=>{
 const body=['while(run()){pop();while(true){if(test()){work();break;}return;}}'];finish(body);
 assert.equal(body[0],'while(run()){pop();if(test()){work();continue;}return;}');
});

test('literal headers flatten only declaration-free blocks and dynamic headers become if',()=>{
 for(const[source,expected,flat,conditional]of[
  ['while(run()){while(true){if(skip())break;return;}}','while(run()){if(skip())continue;return;}',1,0],
  ['while(run()){while(true){int local=read();if(local==0)break;return;}}','while(run()){{int local=read();if(local==0)continue;return;}}',0,0],
  ['for(int i=0;more();i++){while(next()){if(skip())break;return;}}','for(int i=0;more();i++){if(next()){if(skip())continue;return;}}',0,1],
  ['do{while(next()){if(skip())break;return;}}while(more());','do{if(next()){if(skip())continue;return;}}while(more());',0,1],
  ['for(Item item:items){while(next()){if(skip())break;return;}}','for(Item item:items){if(next()){if(skip())continue;return;}}',0,1],
 ]){const result=fold(source);assert.equal(result.source,expected);assert.equal(result.bodyScopesFlattened,flat);assert.equal(result.conditionalBodiesRecovered,conditional);assert.equal(fold(result.source).innerLoopsRecovered,0);}
});

test('terminal blocks, branches, catches and monitors preserve whole scopes and protect dangling else',()=>{
 for(const source of[
  'while(run()){if(selected())while(next()){if(skip())break;return;}else fallback();}',
  'while(run())while(next()){if(skip())break;return;}',
  'while(run()){try{synchronized(lock){while(next()){if(skip())break;return;}}}catch(Exception error){observe(error);}finally{cleanup();}}',
  'while(run()){try{call();}catch(Exception error){while(true){if(skip())break;throw error;}}}',
  'while(run()){End:{while(true){if(skip())break;throw failure;}}}',
 ]){const next=fold(source,{retainDiagnostics:true});assert.equal(next.innerLoopsRecovered,1,source);assert.equal(fold(next.source).innerLoopsRecovered,0);}
 const result=fold('while(run()){if(selected())while(next()){if(skip())break;return;}else fallback();}');
 assert.ok(result.source.includes('if(selected()){if(next()){if(skip())continue;return;}}else fallback();'));
});

test('fallthrough, own continues, suffix actions, switch fallthrough and finally corridors refuse',()=>{
 for(const source of[
  'while(run()){while(true){if(skip())break;work();}}',
  'while(run()){while(true){if(skip())break;continue;}}',
  'while(run()){while(true){if(skip())break;return;}after();}',
  'while(run()){try{while(true){if(skip())break;return;}after();}finally{clean();}}',
  'while(run()){try{return;}finally{while(true){if(skip())break;throw failure;}}}',
  'while(run()){try{throw failure;}finally{if(selected()){while(true){if(skip())break;return;}}}}',
  'while(run()){switch(mode){case 0:while(true){if(skip())break;return;}case 1:after();}}',
  'while(run()){Inner:while(true){break Inner;}}',
  'while(run()){while(true){try{if(skip())break;return;}finally{if(retry())continue;}}}',
  'while(run()){try(Resource resource=new Resource()){while(true){if(skip())break;return;}}}',
  'while(true){if(skip())break;return;}',
 ])assert.equal(fold(source).source,source,source);
});

test('nested-loop and switch exits stay distinct and diagnostics identify each original exit',()=>{
 const source='while(run()){while(true){if(skip()){for(int i=0;i<2;i++){if(test())break;}break;}return;}}',next=fold(source,{retainDiagnostics:true});
 assert.equal(next.breaksContinued,1);assert.ok(next.source.includes('if(test())break;'));assert.ok(next.source.includes('}continue;'));
 const d=next.diagnostics;assert.equal(source.slice(d.loopKeywordRange.start,d.loopKeywordRange.end),'while');assert.equal(source.slice(d.outerLoopKeywordRange.start,d.outerLoopKeywordRange.end),'while');for(const r of d.keywordRanges)assert.equal(source.slice(r.start,r.end),'break');
});

test('unsupported syntax, nested execution, translated offsets and work budgets refuse',()=>{
 for(const source of['while(run()){while(true){if(skip())break;return;}} //keep\n','while(run()){while(true){if(skip())break;return;}}\\u000a',
 'while(run()){while(true){if(skip())break;Runnable task=()->work();return;}}',
 'while(run()){while(true){if(skip())break;Object task=new Object(){};return;}}',
 'while(run()){while(true){if(skip())break;return;}}'+' '.repeat(400001)])assert.equal(fold(source).source,source);
});

test('native loop exits preserve outer updates, condition effects, aliases and protected completion',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'single-pass-inner-native-'));
 const run=(command,args)=>{const files=['out','err'].map(n=>path.join(directory,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(command,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const outer=[body=>`while(outerProbe()){event(0);step++;${body}}`,body=>`for(int index=0;index<3;index=advance(index)){event(0);step++;${body}}`,body=>`do{event(0);step++;${body}}while(step<3);`,body=>`for(int item:new int[]{1,2,3}){event(0);step++;${body}}`];
 const context=[body=>body,body=>`try{${body}}finally{event(7);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,body=>`synchronized(lock){event(6);${body}}`,body=>`try{${body}}catch(IllegalStateException error){event(8);if(error!=FAILURE)throw error;}finally{event(7);}`,body=>`try{synchronized(lock){event(6);${body}}}finally{event(7);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,body=>`try{${body}}finally{new Resource().close();}`];
 const actions='event(1);value=value+step;if(lock!=null){Object alias=lock;if(alias!=lock)throw new AssertionError();}if(inject==1)throw FAILURE;if(step<3||selected){event(2);break;}event(3);if(inject==2)throw FAILURE;return snapshot();';
 try{
  let methods='',models=0;
  for(const make of outer)for(const protect of context)for(const literal of [false,true]){const condition=literal?'true':'probe(boxed)';const source=make(protect('while('+condition+'){'+actions+'}'))+'return snapshot();',next=fold(source);assert.equal(next.innerLoopsRecovered,1,source);
   const expected=make(protect((literal?'{':'if(probe(boxed)){')+'event(1);value=(int)((long)value+step);if(lock!=null){Object alias=lock;if(alias!=lock)throw new AssertionError();}if(inject==1)throw FAILURE;if(step<3||selected){event(2);continue;}event(3);if(inject==2)throw FAILURE;return snapshot();}'))+'return snapshot();';
   methods+=`static String old${models}(Boolean boxed,boolean selected,int inject,int mode){${source}}\nstatic String next${models}(Boolean boxed,boolean selected,int inject,int mode){${next.source}}\nstatic String oracle${models}(Boolean boxed,boolean selected,int inject,int mode){${expected}}\n`;models++;}
  const java=`public class SinglePassInnerNative{static int step,value,effects,closes;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static int closeMode;
static void event(int stage){effects=effects*31+stage;trace.append((char)('a'+stage));}static int advance(int index){event(9);return index+1;}static boolean outerProbe(){event(10);return step<3;}static boolean probe(Boolean boxed){event(4);return boxed.booleanValue();}static String snapshot(){return step+":"+value+":"+effects+":"+closes+":"+trace;}static class Resource implements AutoCloseable{public void close(){closes++;event(5);if(closeMode==1)throw FAILURE;}}
${methods}
static String take(int kind,int variant,Boolean boxed,boolean selected,int inject,int mode,boolean nullLock,int seed,int closeFlag){step=0;value=seed;effects=seed;closes=0;trace=new StringBuilder();lock=nullLock?null:new Object();closeMode=closeFlag;String result;try{switch(kind){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(boxed,selected,inject,mode):variant==1?next${i}(boxed,selected,inject,mode):oracle${i}(boxed,selected,inject,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable error){result=error==FAILURE?"failure":error==OVERRIDE?"override":error.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+snapshot();}
public static void main(String[]args){int cases=0;for(int kind=0;kind<${models};kind++)for(Boolean boxed:new Boolean[]{false,true,null})for(boolean selected:new boolean[]{false,true})for(int inject=0;inject<3;inject++)for(int mode=0;mode<3;mode++)for(boolean nullLock:new boolean[]{false,true})for(int seed:new int[]{Integer.MIN_VALUE,0,Integer.MAX_VALUE})for(int closeFlag=0;closeFlag<2;closeFlag++){String want=take(kind,2,boxed,selected,inject,mode,nullLock,seed,closeFlag);for(int variant=0;variant<2;variant++){String got=take(kind,variant,boxed,selected,inject,mode,nullLock,seed,closeFlag);if(!want.equals(got))throw new AssertionError(kind+":"+variant+":"+boxed+":"+selected+":"+inject+":"+mode+":"+want+":"+got);}cases++;}System.out.println(cases+" cases / ${models} models");}}
`;
  const file=path.join(directory,'SinglePassInnerNative.java');fs.writeFileSync(file,java);run('javac',['--release','8','-d',directory,file]);assert.equal(run('java',['-Xmx128m','-cp',directory,'SinglePassInnerNative']),'31104 cases / 48 models');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('native finally-owned inner exits override pending returns and exceptions at the same outer boundary',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'single-pass-finally-native-'));
 const run=(command,args)=>{const files=['out','err'].map(n=>path.join(directory,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(command,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 try{
  const source='for(int i=0;i<3;i=advance(i)){step++;value=value+step;while(true){try{event(1);if(inject==1)throw FAILURE;return snapshot();}finally{event(7);if(flag==0&&step<3)break;}}}return snapshot();';
  const next=fold(source);assert.equal(next.innerLoopsRecovered,1);
  const oracle='for(int i=0;i<3;i=advance(i)){step++;value=(int)((long)value+step);try{event(1);if(inject==1)throw FAILURE;return snapshot();}finally{event(7);if(flag==0&&step<3)continue;}}return snapshot();';
  const java=`public class FinallyInnerNative{static int step,value,effects;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException();static void event(int n){effects=effects*31+n;trace.append((char)('a'+n));}static int advance(int i){event(9);return i+1;}static String snapshot(){return step+":"+value+":"+effects+":"+trace;}
static String old(int flag,int inject){${source}}static String next(int flag,int inject){${next.source}}static String oracle(int flag,int inject){${oracle}}
static String take(int variant,int flag,int inject,int seed){step=0;value=seed;effects=seed;trace=new StringBuilder();String result;try{result=variant==0?old(flag,inject):variant==1?next(flag,inject):oracle(flag,inject);}catch(Throwable failure){result=failure==FAILURE?"failure":failure.getClass().getName();}return result+":"+snapshot();}
public static void main(String[]args){int cases=0;for(int flag:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int inject=0;inject<2;inject++)for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE}){String want=take(2,flag,inject,seed);for(int variant=0;variant<2;variant++)if(!want.equals(take(variant,flag,inject,seed)))throw new AssertionError(flag+":"+inject+":"+seed);cases++;}System.out.println(cases+" finally override cases");}}
`;
  const file=path.join(directory,'FinallyInnerNative.java');fs.writeFileSync(file,java);run('javac',['--release','8','-d',directory,file]);assert.equal(run('java',['-Xmx128m','-cp',directory,'FinallyInnerNative']),'50 finally override cases');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
