'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{foldLoopFrameCompletion:fold}=require('../src/decompiler/javaAstEmitter');

test('one loop exit guards the complete frame remainder without copying old expressions',()=>{
 const source='Frame:{if(active()){while(next()){before();if(stop())break Frame;after();}}snapshot();}outside();';const r=fold(source,{retainDiagnostics:true});assert.equal(r.exitsRecovered,1);assert.equal(r.labelsRemoved,1);assert.equal(r.guardsAdded,1);assert.ok(!r.source.includes('break Frame'));for(const name of ['active()','next()','before()','stop()','after()','snapshot()','outside()'])assert.equal(r.source.split(name).length-1,1,name);
 assert.match(r.source,/if \(decompiledFrameCompleted0\) \{snapshot\(\);\}/);assert.equal(source.slice(r.diagnostics.jumpRange.start,r.diagnostics.jumpRange.end),'break Frame;');
});
test('intermediate branch/block/label suffixes retain all original scopes and exits',()=>{
 const source='Frame:{Inner:{if(active()){while(next()){before();if(stop())break Frame;after();}int local=read();tail(local);if(done())break Inner;}other();}finish();}';const r=fold(source,{retainDiagnostics:true});assert.equal(r.guardsAdded,3);assert.ok(r.source.includes('if(done())break Inner;'));assert.ok(r.source.includes('int local=read();tail(local);'));
 const shared='Frame:{if(early())break Frame;while(next()){if(stop())break Frame;work();}tail();}';const n=fold(shared,{retainDiagnostics:true});assert.equal(n.labelsRemoved,0);assert.equal(n.diagnostics.labelRetained,true);assert.ok(n.source.includes('if(early())break Frame;'));
});
test('crossed protected/switch/outer-loop corridors and captures refuse',()=>{
 for(const source of [
 'Frame:{while(next()){try{if(stop())break Frame;}finally{cleanup();}}tail();}',
 'Frame:{while(next()){synchronized(lock){if(stop())break Frame;}}tail();}',
 'Frame:{while(next()){switch(value){case 1:if(stop())break Frame;}}tail();}',
 'Frame:{while(outer()){while(next()){if(stop())break Frame;}later();}tail();}',
 'Frame:{try{while(next()){if(stop())break Frame;}tail();}finally{cleanup();}}',
 'Frame:{synchronized(lock){while(next()){if(stop())break Frame;}tail();}}',
 'Frame:{while(next()){if(stop())break Frame;}Runnable r=()->work();}',
 'Frame:{while(next()){if(stop())break Frame;}}',
 ])assert.equal(fold(source).source,source,source);
});
test('for updates, effectful conditions, existing names and whole protected suffixes stay in place',()=>{
 const source='Frame:{for(init();next();update()){before();if(stop())break Frame;after();}try{tail();}finally{cleanup();}}';const r=fold(source,{reservedNames:['decompiledFrameCompleted0']});assert.equal(r.exitsRecovered,1);assert.ok(r.source.includes('decompiledFrameCompleted1'));assert.ok(r.source.includes('for(init();next();update())'));assert.ok(r.source.includes('try{tail();}finally{cleanup();}'));
 assert.equal(fold(source,{retainDiagnostics:1}).exitsRecovered,0);
});
test('guarded suffixes refuse lost definite assignment and permit independent initialization',()=>{
 const source='int value;Frame:{for(;;){if(stop())break Frame;value=read();break;}use(value);}';
 assert.equal(fold(source).source,source);
 const independent='int value;Frame:{while(next()){if(stop())break Frame;}value=read();use(value);}';
 assert.equal(fold(independent).exitsRecovered,1);
});
test('native completion flags match independent loop outcomes and preserve caller finally priority',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'loop-frame-native-'));const run=(cmd,args)=>{const out=path.join(dir,'out'),err=path.join(dir,'err'),fds=[out,err].map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(err,'utf8'));return fs.readFileSync(out,'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const contexts=[s=>s,s=>`try{${s}}finally{event(9);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){event(8);${s}}`,s=>`try{${s}}catch(IllegalStateException e){event(7);if(e!=FAILURE)throw e;}finally{event(9);}`];
 try{let methods='',models=0;for(const protect of contexts)for(const nested of[false,true]){
  const loop='for(index=0;next(limit);update()){event(1);value+=index;if(stop(boxed,stopAt))break Frame;event(2);if(index==earlyAt)break;}';
  const source=protect('Frame:{'+(nested?'Inner:{if(active){'+loop+'event(3);if(skip)break Inner;}event(4);}':loop)+'event(5);}event(6);')+'return snapshot();',r=fold(source);assert.equal(r.exitsRecovered,1,source);
  const outcome='int outcome=scan(limit,boxed,stopAt,earlyAt);if(outcome!=1){'+(nested?'event(3);':'')+'}';
  const oracle=protect((nested?'int branchOutcome=0;if(active){branchOutcome=scan(limit,boxed,stopAt,earlyAt);if(branchOutcome!=1){event(3);}}if(branchOutcome!=1&&(!active||!skip))event(4);if(branchOutcome!=1)event(5);':outcome+'if(outcome!=1)event(5);')+'event(6);')+'return snapshot();';
  for(const[name,body]of[['old',source],['next',r.source],['oracle',oracle]])methods+=`static String ${name}${models}(int limit,Boolean boxed,int stopAt,int earlyAt,boolean active,boolean skip,int mode){${body}}\n`;models++;
 }
 const java=`public class LoopCompletionNative{static int value,index,effects,eventCount,failAt;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){trace.append((char)('a'+n));effects=effects*31+n;if(eventCount++==failAt)throw FAILURE;}static boolean next(int limit){event(0);return index<limit;}static void update(){event(10);index++;}static boolean stop(Boolean boxed,int at){event(11);return boxed.booleanValue()&&index==at;}static String snapshot(){return value+":"+index+":"+effects+":"+trace;}
static int scan(int limit,Boolean boxed,int stopAt,int earlyAt){index=0;for(;;){boolean entered=next(limit);if(!entered)return 0;event(1);value+=index;boolean stopped=stop(boxed,stopAt);if(stopped)return 1;event(2);if(index==earlyAt)return 2;update();}}
${methods}
static String take(int kind,int variant,int limit,Boolean boxed,int stopAt,int earlyAt,boolean active,boolean skip,int mode){value=17;index=0;effects=eventCount=0;trace=new StringBuilder();lock=new Object();String result;try{switch(kind){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(limit,boxed,stopAt,earlyAt,active,skip,mode):variant==1?next${i}(limit,boxed,stopAt,earlyAt,active,skip,mode):oracle${i}(limit,boxed,stopAt,earlyAt,active,skip,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("monitor retained");return result+":"+snapshot();}
public static void main(String[]args){int cases=0;for(int kind=0;kind<${models};kind++)for(int limit=-1;limit<=4;limit++)for(Boolean boxed:new Boolean[]{false,true,null})for(int stopAt=-1;stopAt<=4;stopAt++)for(int earlyAt:new int[]{-1,0,2})for(boolean active:new boolean[]{false,true})for(boolean skip:new boolean[]{false,true})for(int mode=0;mode<3;mode++)for(int failure=-1;failure<16;failure++){failAt=failure;String want=take(kind,2,limit,boxed,stopAt,earlyAt,active,skip,mode);for(int v=0;v<2;v++){String got=take(kind,v,limit,boxed,stopAt,earlyAt,active,skip,mode);if(!want.equals(got))throw new AssertionError(kind+":"+v+":"+limit+":"+boxed+":"+stopAt+":"+earlyAt+":"+active+":"+skip+":"+mode+":"+failure+":"+want+":"+got);}cases++;}System.out.println(cases);}}
`;
 fs.writeFileSync(path.join(dir,'LoopCompletionNative.java'),java);run('javac',['--release','8','-d',dir,path.join(dir,'LoopCompletionNative.java')]);assert.equal(run('java',['-Xmx256m','-cp',dir,'LoopCompletionNative']),'528768');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
