'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {shareDynamicGuardedTails:share}=require('../src/decompiler/javaAstEmitter');
const fold=(s,options={})=>share(s,{minimumSharedTokens:0,...options});

test('dynamic decisions are captured once and complete duplicate tails are shared',()=>{
 const source='Frame:{if(active()){changeActive();if(finish()){work();after();}}else{work();after();}}outside();',r=fold(source,{retainDiagnostics:true});
 assert.equal(r.tailsShared,1);for(const term of ['active()','changeActive()','finish()','work()','after()','outside()'])assert.equal(r.source.split(term).length-1,1,term);
 assert.equal(source.slice(r.diagnostics.conditionRange.start,r.diagnostics.conditionRange.end),'(active())');
 assert.equal(source.slice(r.diagnostics.guardConditionRange.start,r.diagnostics.guardConditionRange.end),'(finish())');
 assert.equal(r.source.slice(r.diagnostics.range.start,r.diagnostics.range.start+7),'boolean');
 const reproduced=r.diagnostics.segments.map(s=>s.text??source.slice(s.range.start,s.range.end)).join('');
 assert.equal(r.source,source.slice(0,r.diagnostics.range.start)+reproduced+source.slice(r.diagnostics.range.end));
});
test('prefix exits and enclosing loop/protection remain at their original sites',()=>{
 for(const context of [s=>s,s=>`try{${s}}finally{cleanup();}`,s=>`synchronized(lock){${s}}`,s=>`Outer:while(next()){${s}}`]){
  const source=context('Frame:{if(active()){before();if(skip())break Frame;if(finish()){work();after();}}else{work();after();}}outside();'),r=fold(source);
  assert.equal(r.tailsShared,1);assert.ok(r.source.includes('if(skip())break Frame;'));assert.ok(r.source.includes('Frame:{'));
 }
 const source='Frame:{if(active()){Inner:{int unused=read();use(unused);}if(finish()){work();after();}}else{work();after();}}';
 assert.equal(fold(source).tailsShared,1,'closed nested local scopes stay whole');
});
test('binding/assignment ambiguity, unsupported tail scopes and malformed options refuse',()=>{
 for(const source of [
  'int x; if(c){x=1;if(g){use(x);}}else{use(x);}',
  'int x=0;if(c){int x=1;if(g){use(x);}}else{use(x);}',
  'if(c){before();if(g){int x=read();use(x);}}else{int x=read();use(x);}',
  'if(c){before();if(g){work();}}else{different();}',
  'if(c){before();if(g){work();}else{extra();}}else{work();}',
  'if(c){before();if(g){try{work();}finally{cleanup();}}}else{try{work();}finally{cleanup();}}',
  'if(c){before();if(g){work();}}else{work();}Runnable r=()->work();',
  'if(c){before();if(g){work();}}else{work();}//comment\n',
  'if(c){before();if(g){work();}}else{work();}\\u000a',
 ])assert.equal(fold(source).source,source,source);
 const source='if(c){before();if(g){work();}}else{work();}';
 for(const options of [{retainDiagnostics:1},{minimumSharedTokens:-1},{minimumSharedTokens:1025},{minimumSharedTokens:1.5}])assert.equal(fold(source,options).tailsShared,0);
 assert.equal(share(source).tailsShared,0,'small tails do not introduce decision locals by default');
 assert.ok(fold(source,{reservedNames:['decompiledSharedTail0']}).source.includes('decompiledSharedTail1'));
});
test('the compiler option is opt-in and keeps its existing default output',()=>{
 const finish=require('../src/decompiler/cfr')._internals.shareExistingExitTails,key='CFR_JS_SHARE_DYNAMIC_GUARDED_TAILS',old=process.env[key];
 const tail='one();two();three();four();five();six();seven();eight();',source='if(condition()){prefix();if(guard()){'+tail+'}}else{'+tail+'}';
 try{delete process.env[key];let body=[source];finish(body);const before=body.join('\n');process.env[key]='1';body=[source];finish(body);assert.notEqual(body.join('\n'),before);assert.ok(body.join('\n').includes('decompiledSharedTail0'));}
 finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}
});
test('native shared tails match independent outcomes under mutation, nulls, failures and protected exits',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-tail-native-'));
 const run=(cmd,args)=>{const files=['out','err'].map(n=>path.join(dir,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const protects=[s=>s,s=>`try{${s}}finally{event(9);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){${s}}`,s=>`try{${s}}catch(IllegalStateException e){event(8);if(e!=FAILURE)throw e;}finally{event(9);}`];
 try{let methods='',models=0;for(const protect of protects)for(const loop of [false,true]){
  const prefix='event(1);value+=seed;selected=!selected;if(early==1)break Frame;'+(loop?'if(early==2)continue Outer;':'');
  const frame='Frame:{if(select(outer)){'+prefix+'if(guard(inner)){tail();}}else{tail();}}event(4);';
  const code=protect((loop?'Outer:for(int i=0;i<2;i++){'+frame+'}':frame)+'event(5);')+'return snapshot();',r=fold(code);assert.equal(r.tailsShared,1,code);
  const oracleFrame='int outcome=oracleStep(outer,inner,seed,early);'+(loop?'if(outcome==2)continue Outer;':'')+'event(4);';
  const oracle=protect((loop?'Outer:for(int i=0;i<2;i++){'+oracleFrame+'}':oracleFrame)+'event(5);')+'return snapshot();';
  for(const[name,body]of [['old',code],['next',r.source],['oracle',oracle]])methods+=`static String ${name}${models}(Boolean outer,Boolean inner,int seed,int early,int mode){${body}}\n`;models++;
 }
 const java=`public class DynamicTailNative{static int value,count,failAt;static boolean selected;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){trace.append(n).append(Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}static boolean select(Boolean x){event(0);selected=x.booleanValue();return selected;}static boolean guard(Boolean x){event(2);return x.booleanValue();}static void tail(){event(3);value=value*31+7;}static String snapshot(){return value+":"+count+":"+selected+":"+trace;}static int oracleStep(Boolean outer,Boolean inner,int seed,int early){boolean chosen=select(outer);if(!chosen){tail();return 0;}event(1);value+=seed;selected=!selected;if(early==1)return 1;if(early==2)return 2;boolean finish=guard(inner);if(finish)tail();return 0;}${methods}
 static String take(int kind,int variant,Boolean outer,Boolean inner,int seed,int early,int mode){value=seed;count=0;selected=false;lock=new Object();trace=new StringBuilder();String result;try{switch(kind){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(outer,inner,seed,early,mode):variant==1?next${i}(outer,inner,seed,early,mode):oracle${i}(outer,inner,seed,early,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("lock leaked");return result+":"+snapshot();}
 public static void main(String[] args){int cases=0;for(int kind=0;kind<${models};kind++)for(Boolean outer:new Boolean[]{false,true,null})for(Boolean inner:new Boolean[]{false,true,null})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int early=0;early<3;early++)for(int mode=0;mode<3;mode++)for(int failure=-1;failure<7;failure++){failAt=failure;int chosenEarly=kind%2==0&&early==2?0:early;String expected=take(kind,2,outer,inner,seed,chosenEarly,mode);for(int variant=0;variant<2;variant++)if(!expected.equals(take(kind,variant,outer,inner,seed,chosenEarly,mode)))throw new AssertionError(kind+":"+variant+":"+outer+":"+inner+":"+seed+":"+early+":"+mode+":"+failure+":"+expected);cases++;}System.out.println(cases);}}
 `;fs.writeFileSync(path.join(dir,'DynamicTailNative.java'),java);run('javac',['--release','8','-d',dir,path.join(dir,'DynamicTailNative.java')]);assert.equal(run('java',['-Xmx128m','-cp',dir,'DynamicTailNative']),'25920');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('native field predicates retain the entry decision after prefix writes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-tail-fields-'));
 const run=(cmd,args)=>{const result=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:1024*1024});if(result.error)throw result.error;assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
 const source='if(active){value++;active=!active;guard=next;if(guard){value*=31;value+=7;}}else{value*=31;value+=7;}',r=fold(source);assert.equal(r.tailsShared,1);
 try{const code=`public class TailFields{static Boolean active,guard;static int value;static String old(Boolean next){${source}return value+":"+active+":"+guard;}static String shared(Boolean next){${r.source}return value+":"+active+":"+guard;}static String oracle(Boolean next){boolean entry=active.booleanValue();if(entry){value++;active=Boolean.FALSE;guard=next;boolean finish=next.booleanValue();if(finish)value=value*31+7;}else value=value*31+7;return value+":"+active+":"+guard;}
 static String take(int variant,Boolean first,Boolean second,Boolean next,int seed){active=first;guard=second;value=seed;try{return variant==0?old(next):variant==1?shared(next):oracle(next);}catch(Throwable e){return e.getClass().getName()+":"+value+":"+active+":"+guard;}}
 public static void main(String[]args){int count=0;for(Boolean first:new Boolean[]{false,true,null})for(Boolean second:new Boolean[]{false,true,null})for(Boolean next:new Boolean[]{false,true,null})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE}){String expected=take(2,first,second,next,seed);for(int variant=0;variant<2;variant++)if(!expected.equals(take(variant,first,second,next,seed)))throw new AssertionError(expected);count++;}System.out.println(count);}}
 `;const file=path.join(dir,'TailFields.java');fs.writeFileSync(file,code);run('javac',['--release','8','-d',dir,file]);assert.equal(run('java',['-cp',dir,'TailFields']),'135');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
