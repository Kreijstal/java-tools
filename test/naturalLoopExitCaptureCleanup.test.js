'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{simplifyNaturalLoopExitCaptures:fold}=require('../src/decompiler/javaAstEmitter');
const source='{boolean done=false;while (!(done = (n >= limit))) {n++;}if(done){finish();}}';
test('sole exit captures disappear while original condition, body and work remain once',()=>{
 const r=fold(source,{parameterNames:['n','limit'],retainDiagnostics:true});assert.equal(r.capturesRemoved,1);assert.equal(r.source,'{while (!(n >= limit)) {n++;}{finish();}}');assert.equal(fold(r.source,{parameterNames:['n','limit']}).capturesRemoved,0);assert.equal(r.source.split('finish()').length-1,1);let expected=source;for(const e of r.diagnostics.edits.slice().sort((a,b)=>b.start-a.start))expected=expected.slice(0,e.start)+e.text+expected.slice(e.end);assert.equal(expected,r.source);
});
test('constant fields/final locals, own breaks/finally breaks and extra flag uses refuse',()=>{
 for(const s of [
  '{boolean done=false;while (!(done = (CONSTANT))) {work();}if(done){finish();}}',
  'final boolean constant=false;{boolean done=false;while (!(done = (constant))) {work();}if(done){finish();}}',
  '{boolean done=false;while (!(done = (holder.CONSTANT))) {work();}if(done){finish();}}',
  '{boolean done=false;while (!(done = (true))) {work();}if(done){finish();}}',
  '{boolean done=false;while (!(done = (n >= limit))) {if(skip())break;work();}if(done){finish();}}',
  '{boolean done=false;Loop:while (!(done = (n >= limit))) {try{work();}finally{if(skip())break Loop;}}if(done){finish();}}',
  '{boolean done=false;while (!(done = (n >= limit))) {use(done);n++;}if(done){finish();}}',
  '{boolean done=false;while (!(done = (n >= limit))) {n++;}if(done){use(done);finish();}}',
  source.replace('boolean done','@Marker boolean done'),
  source+'Runnable r=()->work();',source+'//comment\n',
 ])assert.equal(fold(s,{parameterNames:['n','limit']}).source,s,s);
 assert.equal(fold(source,{parameterNames:null}).capturesRemoved,0);assert.equal(fold(source,{retainDiagnostics:1}).capturesRemoved,0);
});
test('lexical nonconstant evidence respects declaration order, branches and final qualifiers',()=>{
 assert.equal(fold('int n=0;int limit=read();'+source).capturesRemoved,1);
 assert.equal(fold(source+'int n=0;int limit=read();').capturesRemoved,0);
 assert.equal(fold('if(flag){int n=0;int limit=read();work();}'+source).capturesRemoved,0);
 assert.equal(fold('{boolean done=false;while (!(done = (read(holder.CONSTANT)))) {work();}if(done){finish();}}').capturesRemoved,1);
});
test('labels, whole work scopes and nonlocal transfers retain their syntax and destinations',()=>{
 for(const wrap of [s=>s,s=>`try{${s}}finally{cleanup();}`,s=>`synchronized(lock){${s}}`,s=>`if(outer())${s}else other();`]){
  const s=wrap('{boolean done=false;Loop:while (!(done = (end()))) {if(retry())continue Loop;work();}if(done){int x=read();use(x);}}'),r=fold(s);assert.equal(r.capturesRemoved,1);assert.ok(r.source.includes('Loop:while'));assert.ok(r.source.includes('continue Loop;'));assert.ok(r.source.includes('{int x=read();use(x);}'));
 }
 const s='Outer:while(next()){boolean done=false;Loop:while (!(done = (end()))) {if(skip())continue Outer;work();}if(done){finish();}}';assert.equal(fold(s).capturesRemoved,1);
});
test('native direct loops match an independent model under nullable tests, early returns and finally overrides',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'sole-loop-exit-native-')),run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:1024*1024});if(r.error)throw r.error;assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 const wraps=[s=>s,s=>`try{${s}}finally{event(9);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){${s}}`];
 try{let methods='';for(let m=0;m<wraps.length;m++){
  const loop='{boolean done=false;Loop:while (!(done = (ended(signal,limit)))) {try{event(1);index++;value+=seed;if(early==1&&index==1)return snapshot();if(early==2&&index==1)throw OVERRIDE;event(2);}finally{event(7);if(retry&&index<2)continue Loop;}if(index>=4)return snapshot();}if(done){event(3);value=value*31+7;}}';
  const before=wraps[m](loop+'return snapshot();'),after=fold(before);assert.equal(after.capturesRemoved,1);
  const oracle=wraps[m]('for(;;){if(oracleEnd(signal,limit)){event(3);value=value*31+7;break;}int outcome=oracleStep(seed,early,retry);if(outcome==1)return pendingReturn;if(outcome==2)throw OVERRIDE;if(outcome==3)continue;if(index>=4)return snapshot();}return snapshot();');
  for(const[n,s]of [['old',before],['next',after.source],['oracle',oracle]])methods+=`static String ${n}${m}(Boolean signal,int limit,int seed,int early,boolean retry,int mode){${s}}\n`;
 }
 const java=`public class SoleExitOracle{static int index,value,count,failAt;static Object lock;static StringBuilder trace;static String pendingReturn;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){trace.append(n).append(Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}static Boolean ended(Boolean signal,int limit){event(0);return index>=limit?signal:Boolean.FALSE;}static boolean oracleEnd(Boolean signal,int limit){event(0);if(index<limit)return false;if(signal==null)throw new NullPointerException();return signal==Boolean.TRUE;}static int oracleStep(int seed,int early,boolean retry){int decision=0;RuntimeException pending=null;try{event(1);index++;value+=seed;if(index==1&&early==1){pendingReturn=snapshot();decision=1;}else if(index==1&&early==2)decision=2;else event(2);}catch(RuntimeException e){pending=e;}event(7);if(retry&&index<2)return 3;if(pending!=null)throw pending;return decision;}static String snapshot(){return index+":"+value+":"+count+":"+trace;}\n${methods}
 static String take(int model,int variant,Boolean signal,int limit,int seed,int early,boolean retry,int mode){index=0;value=seed;count=0;pendingReturn=null;trace=new StringBuilder();lock=new Object();String result;try{switch(model){${wraps.map((_,m)=>`case ${m}:result=variant==0?old${m}(signal,limit,seed,early,retry,mode):variant==1?next${m}(signal,limit,seed,early,retry,mode):oracle${m}(signal,limit,seed,early,retry,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("lock leaked");return result+":"+snapshot();}
 public static void main(String[]args){int cases=0;for(int model=0;model<${wraps.length};model++)for(Boolean signal:new Boolean[]{false,true,null})for(int limit:new int[]{0,1,3,5})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int early=0;early<3;early++)for(boolean retry:new boolean[]{false,true})for(int mode=0;mode<3;mode++)for(int failure=-1;failure<11;failure++){failAt=failure;String expected=take(model,2,signal,limit,seed,early,retry,mode);for(int variant=0;variant<2;variant++){String actual=take(model,variant,signal,limit,seed,early,retry,mode);if(!expected.equals(actual))throw new AssertionError(model+":"+signal+":"+limit+":"+early+":"+retry+":"+mode+":"+failure+":"+expected+":"+actual);}cases++;}System.out.println(cases);}}`;
 fs.writeFileSync(d+'/SoleExitOracle.java',java);run('javac',['--release','8','-d',d,d+'/SoleExitOracle.java']);assert.equal(run('java',['-Xmx128m','-cp',d,'SoleExitOracle']),'38880');
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('compiler cleanup is opt-in and retains captured decisions by default',()=>{
 const finish=require('../src/decompiler/cfr')._internals.shareExistingExitTails,key='CFR_JS_SIMPLIFY_NATURAL_LOOP_EXIT_CAPTURES',old=process.env[key];try{delete process.env[key];let b=[source];finish(b,['n','limit']);const prior=b.join('\n');process.env[key]='1';b=[source];finish(b,['n','limit']);assert.notEqual(b.join('\n'),prior);assert.ok(!b.join('\n').includes('done'));}finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}
});
