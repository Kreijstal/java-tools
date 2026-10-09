'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {foldSharedStatementFallbacks:fold,foldSharedGuardedFallbacks:old,foldTerminalGuardedFrameExits:finishGuards}=require('../src/decompiler/javaAstEmitter');
const {shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;
test('mixed calls and stores share a complete ordered continuation between exclusive arms',()=>{
 const source='F:{if(branch()){before();if(guard())break F;}obj.value=read();after(obj.value);if(last())complete();}';const next=fold(source,{retainDiagnostics:true});
 assert.equal(next.source,'if(branch()){before();if (!(guard())) {obj.value=read();after(obj.value);if(last())complete();}} else {obj.value=read();after(obj.value);if(last())complete();}');assert.equal(next.guardsRecovered,1);assert.equal(next.labelsRemoved,1);assert.equal(next.fallbackStatementSitesAdded,3);assert.equal(next.fallbackConditionsAdded,1);assert.equal(fold(next.source).guardsRecovered,0);assert.equal(old(source).guardsRecovered,0);
});
test('shared exits and enclosing scopes remain while complete fallback ranges are reused',()=>{
 const source='Outer:while(run()){try{synchronized(lock){F:{if(skip())break F;if(branch()){before();if(guard())break F;}obj.arr[index()]=boxed();call(receiver(),new Object(),obj);}}}finally{cleanup();}}';const next=fold(source,{retainDiagnostics:true});assert.equal(next.guardsRecovered,1);assert.equal(next.sharedFramesRetained,1);assert.ok(next.source.includes('F:{if(skip())break F;'));assert.ok(next.source.endsWith('}}finally{cleanup();}}'));
 const d=next.diagnostics,parts=d.segments.filter(s=>s.range&&s.range.start===d.fallbackRange.start&&s.range.end===d.fallbackRange.end);assert.equal(parts.length,2);assert.equal(parts.filter(s=>s.copy).length,1);assert.equal(source.slice(d.fallbackRange.start,d.fallbackRange.end),'obj.arr[index()]=boxed();call(receiver(),new Object(),obj);');
});
test('multiline continuation indentation follows the exclusive arms',()=>{
 const source='F: {\n  if(a) {\n    before();\n    if(g) {\n      break F;\n    }\n  }\n  call();\n  if(b) {\n    work();\n  }\n}';assert.equal(fold(source).source,'if(a) {\n  before();\n  if (!(g)) {\n    call();\n    if(b) {\n      work();\n    }\n  }\n} else {\n  call();\n  if(b) {\n    work();\n  }\n}');
});
test('declarations, lexical executables, protected suffixes, transfers and budget excess refuse',()=>{
 const wrap=s=>'F:{if(a){before();if(g)break F;}'+s+'}';
 for(const suffix of ['int x=read();work(x);','while(a)work();','if(a)break F;','try{work();}finally{cleanup();}','synchronized(lock){work();}','if(a){int value=0;work(value);}','Runnable r=()->work();','obj.callback=receiver::method;','new Object(){void run(){work();}};','return;','call();'.repeat(9),'call('+Array.from({length:257},()=> 'a').join(',')+');'])assert.equal(fold(wrap(suffix)).guardsRecovered,0,suffix.slice(0,70));
 for(const source of ['F:{if(a){int value=0;if(g)break F;}work(value);}', 'F:{try{if(a){work();if(g)break F;}one();two();}finally{cleanup();}}','F:{if(a){work();if(g)break F;}one();two();}// comment\n','F:{if(a){work();if(g)break F;}one();two();}\\u000a','F:{if(a){work();if(g)break F;}one();two();}'+' '.repeat(400001)])assert.equal(fold(source).guardsRecovered,0);
});
test('normal emitter uses mixed statement recovery after earlier store and callback passes',()=>{
 const body=['F:{if(first()){before();if(guard())break F;}obj.x=read();after(obj.x);}'];finish(body);assert.equal(body[0],'if(first()){before();if (!(guard())) {obj.x=read();after(obj.x);}} else {obj.x=read();after(obj.x);}');
});
test('multiple recoveries keep one evaluation per original path without assuming stable predicates',()=>{
 let s='F:{if(a){if(b){work();if(g)break F;}one();if(h)break F;}two();three();}';let count=0;for(;;){const n=fold(s);if(!n.guardsRecovered)break;s=n.source;count++;}assert.equal(count,2);assert.ok(!s.includes('break F'));assert.equal(fold(s).guardsRecovered,0);
});
test('normal emission finishes an earlier shared exit after mixed continuations become exclusive',()=>{
 const body=['F:{if(a){if(skip())break F;before();if(guard())break F;}obj.x=read();after(obj.x);}'];finish(body);
 assert.equal(body[0],'if(a){if (!(skip())) {before();if (!(guard())) {obj.x=read();after(obj.x);}}} else {obj.x=read();after(obj.x);}');
 assert.ok(!body[0].includes('break F'));
});
test('native mixed continuations preserve callbacks, nullable conditions, boxing, aliasing and abrupt completion',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'statement-fallback-native-'));
 const run=(cmd,args)=>{const out=path.join(dir,'out'),err=path.join(dir,'err'),fds=[out,err].map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(err,'utf8'));return fs.readFileSync(out,'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 try{
  const contexts=[s=>s,s=>`try{${s}}finally{event(7);if(mode==1)return snap();if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){${s}}`,s=>`try{synchronized(lock){${s}}}finally{event(7);if(mode==1)return snap();if(mode==2)throw OVERRIDE;}`,s=>`try{${s}}catch(IllegalStateException failure){event(8);if(failure!=FAILURE)throw failure;}finally{event(7);}`,s=>`{Box alias=box;${s}if(alias!=box)throw new AssertionError();}`];
  const suffixes=['box.value=read(2);call(receiver(),new Object(),read(3));array[index()]=boxed();','if(probe(tail,2)){box.value=read(3);call(box,new Object(),read(4));}else{array[index()]=boxed();call(box,null,read(5));}','box.value+=read(2);box.value=box.value/divisor;call(box,new Object(),box.value);'];let methods='',models=0;
  for(const suffix of suffixes)for(const protect of contexts){
   const input=protect(`F:{if(probe(branch,0)){if(probe(tail,6))break F;event(1);box.value=box.value+1;if(probe(guard,1))break F;}${suffix}}event(9);`)+'return snap();',next=fold(input);assert.equal(next.guardsRecovered,1);let final=next.source;for(;;){const done=finishGuards(final);if(!done.guardsRecovered)break;final=done.source;}assert.ok(!final.includes('break F'));
   const oracle=protect(`boolean selected=probe(branch,0);boolean skipped=false;if(selected){skipped=probe(tail,6);if(!skipped){event(1);box.value=box.value+1;skipped=probe(guard,1);}}if(!skipped){${suffix}}event(9);`)+'return snap();';
   for(const[name,s]of[['old',input],['next',next.source],['final',final],['oracle',oracle]])methods+=`static String ${name}${models}(Boolean branch,Boolean guard,Boolean tail,int divisor,int mode){${s}}\n`;models++;
  }
  const java=`public class StatementFallbackNative{static class Box{int value;}static Box box;static Object lock;static int[]array;static int count,inject;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){trace.append((char)('a'+n));count=count*31+n;if(inject==n)throw FAILURE;}static Boolean probe(Boolean value,int n){event(n);return value;}static int read(int n){event(n);return count;}static Box receiver(){event(3);return box;}static int index(){event(4);return count%3;}static Integer boxed(){event(5);return inject==10?null:Integer.valueOf(count);}static void call(Box target,Object identity,int value){event(6);target.value=target.value+value;if(identity!=null&&identity==box)throw new AssertionError();}static String snap(){return count+":"+(box==null?"null":box.value)+":"+java.util.Arrays.toString(array)+":"+trace;}
${methods}
static String take(int kind,int variant,Boolean branch,Boolean guard,Boolean tail,int divisor,int mode,int seed,int failure,boolean missing){count=seed;trace=new StringBuilder();box=missing?null:new Box();if(box!=null)box.value=seed;lock=missing?null:new Object();array=new int[]{seed,1,2};inject=failure;String result;try{switch(kind){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(branch,guard,tail,divisor,mode):variant==1?next${i}(branch,guard,tail,divisor,mode):variant==2?final${i}(branch,guard,tail,divisor,mode):oracle${i}(branch,guard,tail,divisor,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable error){result=error==FAILURE?"failure":error==OVERRIDE?"override":error.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError();return result+":"+snap();}
public static void main(String[]args){int cases=0;for(int kind=0;kind<${models};kind++)for(Boolean branch:new Boolean[]{false,true,null})for(Boolean guard:new Boolean[]{false,true,null})for(Boolean tail:new Boolean[]{false,true,null})for(int divisor:new int[]{0,1,-1,2})for(int mode=0;mode<3;mode++)for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int failure=0;failure<11;failure++)for(boolean missing:new boolean[]{false,true}){String expected=take(kind,3,branch,guard,tail,divisor,mode,seed,failure,missing);for(int variant=0;variant<3;variant++)if(!take(kind,variant,branch,guard,tail,divisor,mode,seed,failure,missing).equals(expected))throw new AssertionError(kind+":"+variant+":"+failure);cases++;}System.out.println(cases+" cases, ${models} models");}}`;
  fs.writeFileSync(path.join(dir,'StatementFallbackNative.java'),java);run('javac',['-d',dir,path.join(dir,'StatementFallbackNative.java')]);assert.equal(run('java',['-Xmx128m','-cp',dir,'StatementFallbackNative']),'641520 cases, 18 models');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
