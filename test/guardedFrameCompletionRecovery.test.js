'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{foldGuardedFrameCompletion:fold}=require('../src/decompiler/javaAstEmitter');
test('nested frame exits capture original decisions and guard all remaining suffixes',()=>{
 const s='Frame:{if(outer()){prefix();if(stop())break Frame;work();if(done())break Frame;}rest();}after();',r=fold(s,{retainDiagnostics:true});assert.equal(r.framesRecovered,1);assert.equal(r.jumpsRemoved,2);assert.equal(r.guardsAdded,2);assert.ok(!r.source.includes('Frame:'));for(const t of ['outer()','prefix()','stop()','work()','done()','rest()','after()'])assert.equal(r.source.split(t).length-1,1,t);let expected=s;for(const e of r.diagnostics.edits)expected=expected.slice(0,e.start)+e.text+expected.slice(e.end);assert.equal(expected,r.source);assert.equal(fold(r.source).framesRecovered,0);
});
test('adjacent/nested suffix boundaries, else arms and intact scopes compose',()=>{
 for(const s of ['Frame:{if(one())break Frame;if(two())break Frame;work();}',
  'Frame:{if(outer()){if(one())break Frame;int x=read();use(x);if(two())break Frame;}else{if(three())break Frame;other();}after();}',
  'Outer:while(next()){Frame:{if(outer()){if(one())break Frame;work();}tail();}if(skip())continue Outer;}',
  'if(outer())Frame:{if(one())break Frame;work();}else other();',
  'try{Frame:{if(outer()){if(one())break Frame;work();}tail();}}finally{cleanup();}',
  'synchronized(lock){Frame:{if(outer()){if(one())break Frame;work();}tail();}}']){
  const r=fold(s);assert.equal(r.framesRecovered,1,s);assert.ok(!r.source.includes('Frame:'));
 }
});
test('multiline decisions remain intact inside nested suffix indentation',()=>{
 const source=`Frame: {
  if (outer()) {
    if (first()) break Frame;
    work();
    if (
      second()
    ) {
      break Frame;
    }
    next();
  }
  tail();
}`;
 const result=fold(source,{retainDiagnostics:true});
 assert.equal(result.framesRecovered,1);
 assert.equal(result.jumpsRemoved,2);
 for(const action of ['outer()','first()','work()','second()','next()','tail()'])assert.equal(result.source.split(action).length-1,1,action);
 const {JavaParser}=require('../src/java-frontend/parser');
 assert.doesNotThrow(()=>new JavaParser().parseCompilationUnit(`class Example { void run() { ${result.source} } }`));
 for(const edit of result.diagnostics.edits.filter(e=>e.kind==='indent'))assert.ok(!result.diagnostics.guards.some(g=>g.range.start<edit.start&&edit.start<g.range.end));
});
test('crossed loop/protected corridors, captures and ambiguous assignment refuse',()=>{
 for(const s of ['Frame:{while(next()){if(stop())break Frame;work();}tail();}',
 'Frame:{try{if(stop())break Frame;work();}finally{cleanup();}tail();}',
 'Frame:{synchronized(lock){if(stop())break Frame;work();}tail();}',
 'int x;Frame:{if(stop())break Frame;use(x);}',
 'Frame:{if(stop()){before();break Frame;}work();}',
 'Frame:{if(stop())continue Frame;work();}',
 'Frame:{if(stop())break Frame;work();}Runnable r=()->work();',
 'Frame:{if(stop())break Frame;work();}//comment\n'])assert.equal(fold(s).source,s,s);
 assert.equal(fold('Frame:{if(stop())break Frame;work();}',{reservedNames:null}).framesRecovered,0);
 assert.equal(fold('Frame:{if(stop())break Frame;work();}',{retainDiagnostics:1}).framesRecovered,0);
 assert.ok(fold('Frame:{if(stop())break Frame;work();}',{reservedNames:['decompiledFrameRemainder0']}).source.includes('decompiledFrameRemainder1'));
});
test('native multiple exits match independent ordered outcomes under nulls, writes and protected failures',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guarded-frame-native-')),run=(cmd,args)=>{const files=['out','err'].map(n=>path.join(dir,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));for(const f of files)assert.ok(fs.statSync(f).size<=1024*1024);return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const wraps=[s=>s,s=>`try{${s}}finally{event(9);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){${s}}`,s=>`try{${s}}catch(IllegalStateException e){event(8);if(e!=FAILURE)throw e;}finally{event(9);}return snapshot();`];
 try{let methods='';for(let m=0;m<wraps.length;m++){
  const frame=`Frame: {
    if (choice(outer,0)) {
      event(1); value+=seed; selected=!selected;
      if (choice(first,2)) break Frame;
      event(3); value=value*31+7;
      if (
        choice(second,4)
      ) {
        break Frame;
      }
    } else {
      event(5);
      if (choice(third,6)) break Frame;
    }
    event(7); value=value*17-3;
  }
  event(10);`;
  const before=wraps[m](frame+'return snapshot();'),after=fold(before);assert.equal(after.framesRecovered,1,before);assert.equal(after.jumpsRemoved,3);
  const oracle=wraps[m]('boolean remainder=oracleFrame(outer,first,second,third,seed);if(remainder){event(7);value=value*17-3;}event(10);return snapshot();');
  for(const[n,s]of [['old',before],['next',after.source],['oracle',oracle]])methods+=`static String ${n}${m}(Boolean outer,Boolean first,Boolean second,Boolean third,int seed,int mode){${s}}\n`;
 }
 const java=`public class FrameOracle{static int value,count,failAt;static boolean selected;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){trace.append(n).append(Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}static boolean choice(Boolean x,int e){event(e);return x.booleanValue();}static boolean oracleChoice(Boolean x,int e){event(e);if(x==null)throw new NullPointerException();return x==Boolean.TRUE;}static boolean oracleFrame(Boolean outer,Boolean first,Boolean second,Boolean third,int seed){if(!oracleChoice(outer,0)){event(5);return !oracleChoice(third,6);}event(1);value+=seed;selected=!selected;if(oracleChoice(first,2))return false;event(3);value=value*31+7;if(oracleChoice(second,4))return false;return true;}static String snapshot(){return value+":"+count+":"+selected+":"+trace;}\n${methods}
 static String take(int model,int variant,Boolean outer,Boolean first,Boolean second,Boolean third,int seed,int mode){value=seed;count=0;selected=false;trace=new StringBuilder();lock=new Object();String result;try{switch(model){${wraps.map((_,m)=>`case ${m}:result=variant==0?old${m}(outer,first,second,third,seed,mode):variant==1?next${m}(outer,first,second,third,seed,mode):oracle${m}(outer,first,second,third,seed,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("lock leaked");return result+":"+snapshot();}
 public static void main(String[]args){int cases=0;for(int model=0;model<${wraps.length};model++)for(Boolean outer:new Boolean[]{false,true,null})for(Boolean first:new Boolean[]{false,true,null})for(Boolean second:new Boolean[]{false,true,null})for(Boolean third:new Boolean[]{false,true,null})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int mode=0;mode<3;mode++)for(int failure=-1;failure<12;failure++){failAt=failure;String expected=take(model,2,outer,first,second,third,seed,mode);for(int variant=0;variant<2;variant++){String actual=take(model,variant,outer,first,second,third,seed,mode);if(!expected.equals(actual))throw new AssertionError(model+":"+outer+":"+first+":"+second+":"+third+":"+seed+":"+mode+":"+failure+":"+expected+":"+actual);}cases++;}System.out.println(cases);}}
 `;fs.writeFileSync(dir+'/FrameOracle.java',java);run('javac',['--release','8','-d',dir,dir+'/FrameOracle.java']);assert.equal(run('java',['-Xmx128m','-cp',dir,'FrameOracle']),'63180');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('compiler frame completion is opt-in',()=>{const finish=require('../src/decompiler/cfr')._internals.shareExistingExitTails,key='CFR_JS_GUARDED_FRAME_COMPLETION',old=process.env[key],source='Frame:{if(outer()){prefix();if(stop())break Frame;work();}tail();}';try{delete process.env[key];let body=[source];finish(body);const prior=body.join('\n');process.env[key]='1';body=[source];finish(body);assert.notEqual(body.join('\n'),prior);assert.ok(body.join('\n').includes('decompiledFrameRemainder0'));}finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}});
