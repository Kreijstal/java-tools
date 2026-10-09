'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{foldLeadingLoopExitWork:fold}=require('../src/decompiler/javaAstEmitter');
test('leading exit work moves once and other loop breaks skip it',()=>{
 const source='while(true){if(end()){finish();break;}if(stop())break;work();}outside();',r=fold(source,{retainDiagnostics:true});assert.equal(r.loopsRecovered,1);assert.equal(r.diagnostics.otherLoopBreaks,1);for(const term of ['end()','finish()','stop()','work()','outside()'])assert.equal(r.source.split(term).length-1,1,term);assert.equal(fold(r.source).loopsRecovered,0);assert.equal(source.slice(r.diagnostics.removedExitRange.start,r.diagnostics.removedExitRange.end),'break;');const d=r.diagnostics;assert.equal(r.source,source.slice(0,d.range.start)+d.segments.map(s=>s.text??source.slice(s.range.start,s.range.end)).join('')+source.slice(d.range.end));
});
test('labels, continue/finally overrides and enclosing protection stay intact',()=>{
 for(const wrap of [s=>s,s=>`try{${s}}finally{cleanup();}`,s=>`synchronized(lock){${s}}`,s=>`if(outer())${s}else other();`]){
  const s=wrap('Loop:while(true){if(end()){finish();break Loop;}try{if(stop())break Loop;work();}finally{if(retry())continue Loop;}}'),r=fold(s,{retainDiagnostics:true});assert.equal(r.loopsRecovered,1,s);assert.equal(r.diagnostics.label,'Loop');assert.ok(r.source.includes('Loop:while'));assert.ok(r.source.includes('continue Loop;'));assert.ok(r.source.includes('if(stop())break Loop;'));
 }
 const nested='Outer:while(next()){Loop:while(true){if(end()){if(stopOuter())break Outer;finish();break Loop;}if(skipOuter())continue Outer;if(stopInner())break Loop;}}';assert.equal(fold(nested).loopsRecovered,1);
});
test('unsafe self exits, ambiguous assignment, captures and unsupported input refuse',()=>{
 for(const s of [
  'while(true){if(end()){if(retry())continue;finish();break;}work();}',
  'Loop:while(true){if(end()){try{finish();}finally{if(retry())continue Loop;}break Loop;}work();}',
  'int x;while(true){if(end()){x=read();break;}work();}use(x);',
  'while(true){before();if(end()){finish();break;}work();}',
  'while(true){if(end()){finish();break;}else other();work();}',
  'while(next()){if(end()){finish();break;}work();}',
  'while(true){if(end()){finish();break;}Runnable r=()->work();}',
  'while(true){if(end()){finish();break;}work();}//comment\n',
 ])assert.equal(fold(s).source,s,s);
 const source='while(true){if(end()){finish();break;}work();}';assert.equal(fold(source,{reservedNames:null}).loopsRecovered,0);assert.equal(fold(source,{retainDiagnostics:1}).loopsRecovered,0);assert.ok(fold(source,{reservedNames:['decompiledNaturalLoopExit0']}).source.includes('decompiledNaturalLoopExit1'));
});
test('compiler integration is opt-in',()=>{
 const finish=require('../src/decompiler/cfr')._internals.shareExistingExitTails,key='CFR_JS_LEADING_LOOP_EXIT_WORK',old=process.env[key],s='while(true){if(end()){finish();break;}if(stop())break;work();}';try{delete process.env[key];let b=[s];finish(b);const prior=b.join('\n');process.env[key]='1';b=[s];finish(b);assert.notEqual(b.join('\n'),prior);assert.ok(b.join('\n').includes('decompiledNaturalLoopExit0'));}finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}
});
test('native exit-only work matches independent outcomes under nullable guards and protected overrides',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'leading-loop-exit-native-'));
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:1024*1024});if(r.error)throw r.error;assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 const wraps=[s=>s,s=>`try{${s}}finally{event(9);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){${s}}`,s=>`try{${s}}catch(IllegalStateException e){event(8);if(e!=FAILURE&&e!=OVERRIDE)throw e;}finally{event(9);}return snapshot();`];
 try{let methods='';for(let model=0;model<wraps.length;model++){
  const work='event(3);value=value*31+7;if(finish==1)return snapshot();if(finish==2)throw OVERRIDE;';
  const body='try{event(1);index++;value+=seed;if(early==1&&index==1)break Loop;if(early==2&&index==1)continue Loop;event(2);}finally{event(7);if(retry&&index<3)continue Loop;}if(index>=4)break Loop;';
  const source=wraps[model](`Loop:while(true){if(ended(signal,limit)){${work}break Loop;}${body}}`+'return snapshot();');
  const candidate=fold(source);assert.equal(candidate.loopsRecovered,1,source);
  const oracle=wraps[model]('for(;;){boolean done=oracleEnd(signal,limit);if(done){oracleFinish(finish);if(finish==1)return snapshot();break;}int outcome=oracleStep(seed,early,retry);if(outcome==1)break;if(outcome==2)continue;if(index>=4)break;}'+'return snapshot();');
  for(const[name,code]of [['old',source],['next',candidate.source],['oracle',oracle]])methods+=`static String ${name}${model}(Boolean signal,int limit,int seed,int early,boolean retry,int mode,int finish){${code}}\n`;
 }
 const java=`public class ExitWorkOracle{static int index,value,count,failAt;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){trace.append(n).append(Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}static Boolean ended(Boolean signal,int limit){event(0);return index>=limit?signal:Boolean.FALSE;}static boolean oracleEnd(Boolean signal,int limit){event(0);if(index<limit)return false;if(signal==null)throw new NullPointerException();return signal==Boolean.TRUE;}static void oracleFinish(int finish){event(3);value=value*31+7;if(finish==2)throw OVERRIDE;}static int oracleStep(int seed,int early,boolean retry){int decision=0;RuntimeException pending=null;try{event(1);index++;value+=seed;if(index==1&&early==1)decision=1;else if(index==1&&early==2)decision=2;else event(2);}catch(RuntimeException e){pending=e;}event(7);if(retry&&index<3)return 2;if(pending!=null)throw pending;return decision;}static String snapshot(){return index+":"+value+":"+count+":"+trace;}\n${methods}
 static String take(int model,int variant,Boolean signal,int limit,int seed,int early,boolean retry,int mode,int finish){index=0;value=seed;count=0;trace=new StringBuilder();lock=new Object();String result;try{switch(model){${wraps.map((_,m)=>`case ${m}:result=variant==0?old${m}(signal,limit,seed,early,retry,mode,finish):variant==1?next${m}(signal,limit,seed,early,retry,mode,finish):oracle${m}(signal,limit,seed,early,retry,mode,finish);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("lock leaked");return result+":"+snapshot();}
 public static void main(String[]args){int cases=0;for(int model=0;model<${wraps.length};model++)for(Boolean signal:new Boolean[]{false,true,null})for(int limit:new int[]{0,1,3,5})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int early=0;early<3;early++)for(boolean retry:new boolean[]{false,true})for(int mode=0;mode<3;mode++)for(int finish=0;finish<3;finish++)for(int failure=-1;failure<11;failure++){failAt=failure;String expected=take(model,2,signal,limit,seed,early,retry,mode,finish);for(int variant=0;variant<2;variant++){String actual=take(model,variant,signal,limit,seed,early,retry,mode,finish);if(!expected.equals(actual))throw new AssertionError(model+":"+signal+":"+limit+":"+early+":"+retry+":"+mode+":"+finish+":"+failure+":"+expected+":"+actual);}cases++;}System.out.println(cases);}}
 `;fs.writeFileSync(path.join(directory,'ExitWorkOracle.java'),java);run('javac',['--release','8','-d',directory,path.join(directory,'ExitWorkOracle.java')]);assert.equal(run('java',['-Xmx128m','-cp',directory,'ExitWorkOracle']),'155520');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
