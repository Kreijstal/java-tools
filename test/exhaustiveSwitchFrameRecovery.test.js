'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {foldExhaustiveSwitchFrameExits:fold,reindentStructuredSource:indent}=require('../src/decompiler/javaAstEmitter');

test('exhaustive cases become local exits and the original remainder becomes else',()=>{
 const source='Exit:{prefix();if(test()){switch(selector()){case 1:one();break Exit;default:other();break Exit;}}fallback();}tail();',r=fold(source,{retainDiagnostics:true});
 assert.equal(r.framesRecovered,1);assert.equal(r.breaksLocalized,2);assert.ok(!r.source.includes('Exit:'));assert.ok(!r.source.includes('break Exit'));assert.match(r.source,/else \{fallback\(\);/);
 for(const call of ['prefix()','test()','selector()','one()','other()','fallback()','tail()'])assert.equal(r.source.split(call).length-1,1,call);
 let expected=source;for(const e of r.diagnostics.edits)expected=expected.slice(0,e.start)+e.text+expected.slice(e.end);assert.equal(r.source,expected);assert.equal(fold(r.source).framesRecovered,0);
});

test('case protection stays whole and outer loops/protection keep their boundaries',()=>{
 const frame='Exit:{if(test()){switch(x){case 1:try{one();}finally{cleanup();}break Exit;default:synchronized(lock){other();}break Exit;}}fallback();}';
 for(const source of [frame,'try{'+frame+'}finally{done();}','synchronized(lock){'+frame+'}','Outer:while(next()){'+frame+'if(skip())continue Outer;}']){const r=fold(source);assert.equal(r.framesRecovered,1,source);for(const call of ['cleanup()','fallback()'])assert.equal(r.source.split(call).length-1,1);}
});

test('nonexhaustive/fallthrough/crossed/extra exits and captures refuse',()=>{
 for(const source of [
  'Exit:{if(test()){switch(x){case 1:one();break Exit;}}fallback();}',
  'Exit:{if(test()){switch(x){case 1:one();default:other();break Exit;}}fallback();}',
  'Exit:{if(test()){switch(x){case 1:one();break;default:other();break Exit;}}fallback();}',
  'Exit:{if(test()){switch(x){case 1:if(skip())break;one();break Exit;default:other();break Exit;}}fallback();}',
  'Exit:{if(test()){switch(x){case 1:try{one();break Exit;}finally{cleanup();}default:other();break Exit;}}fallback();}',
  'Exit:{if(test()){switch(x){case 1:while(next()){break Exit;}break Exit;default:other();break Exit;}}fallback();}',
  'Exit:{if(test()){switch(x){case 1:one();break Exit;default:other();break Exit;}afterSwitch();}fallback();}',
  'Exit:{if(test()){switch(x){case 1:one();break Exit;default:other();break Exit;}}else different();fallback();}',
  'Exit:{if(test()){switch(x){case 1:one();break Exit;default:other();break Exit;}}if(skip())break Exit;fallback();}',
  'Exit:{if(test()){switch(x){case 1:one();break Exit;default:other();break Exit;}}fallback();}Runnable r=()->other();',
  'Exit:{if(test()){switch(x){case 1:one();break Exit;default:other();break Exit;}}fallback();}//comment\n'
 ])assert.equal(fold(source).source,source,source);
});

test('native switch scopes preserve nullable guards/selectors, alias stores and protected failures',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'exhaustive-switch-native-'));
 const run=(command,args)=>{const files=['out','err'].map(n=>path.join(dir,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(command,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));for(const f of files)assert.ok(fs.statSync(f).size<=1024*1024);return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const wraps=[s=>s,s=>`try{${s}}finally{event(9);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){${s}}`,s=>`try{${s}}catch(IllegalStateException e){event(8);if(e!=FAILURE)throw e;}finally{event(9);}return snapshot();`];
 try{let methods='';for(let m=0;m<wraps.length;m++){
  const frame='Exit:{event(0);if(choice(guard)){switch(select(selector)){case -1:store(1);break Exit;case 0:try{store(2);}finally{event(6);}break Exit;default:store(3);break Exit;case 4:synchronized(lock){store(4);}break Exit;}}store(5);}event(7);return snapshot();',before=wraps[m](frame),after=fold(before);assert.equal(after.framesRecovered,1);assert.equal(after.breaksLocalized,4);
  const oracle=wraps[m]('event(0);event(10);if(guard==null)throw new NullPointerException();if(guard==Boolean.TRUE){event(11);if(selector==null)throw new NullPointerException();int x=selector.intValue();if(x==-1)store(1);else if(x==0){try{store(2);}finally{event(6);}}else if(x==4){synchronized(lock){store(4);}}else store(3);}else store(5);event(7);return snapshot();');
  for(const[n,s]of [['old',before],['next',indent(after.source).source],['oracle',oracle]])methods+=`static String ${n}${m}(Boolean guard,Integer selector,int mode){${s}}\n`;
 }
 const java=`public class SwitchOracle{static int value,count,failAt,index;static Object lock;static int[] array,alias;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){value=value*31+n;trace.append(n).append(Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}static boolean choice(Boolean x){event(10);return x.booleanValue();}static int select(Integer x){event(11);return x.intValue();}static void store(int n){event(n);alias[index]=value;}static String snapshot(){return value+":"+count+":"+trace+":"+(array==null?"null":java.util.Arrays.toString(array))+":"+(alias==array);}
 ${methods}
 static String take(int model,int variant,Boolean guard,Integer selector,int mode,int seed,int arrayMode){value=seed;count=0;trace=new StringBuilder();lock=new Object();array=arrayMode==0?null:new int[]{seed,seed};alias=array;index=arrayMode==2?-1:arrayMode==3?2:0;String result;try{switch(model){${wraps.map((_,m)=>`case ${m}:result=variant==0?old${m}(guard,selector,mode):variant==1?next${m}(guard,selector,mode):oracle${m}(guard,selector,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("lock leaked");return result+":"+snapshot();}
 public static void main(String[]args){int cases=0;for(int model=0;model<${wraps.length};model++)for(Boolean guard:new Boolean[]{false,true,null})for(Integer selector:new Integer[]{-1,0,4,7,null})for(int mode=0;mode<3;mode++)for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int arrayMode=0;arrayMode<4;arrayMode++)for(int failure=-1;failure<12;failure++){failAt=failure;String expected=take(model,2,guard,selector,mode,seed,arrayMode);for(int variant=0;variant<2;variant++){String actual=take(model,variant,guard,selector,mode,seed,arrayMode);if(!expected.equals(actual))throw new AssertionError(model+":"+guard+":"+selector+":"+mode+":"+seed+":"+arrayMode+":"+failure+":"+expected+":"+actual);}cases++;}System.out.println(cases);}}
 `;fs.writeFileSync(dir+'/SwitchOracle.java',java);run('javac',['--release','8','-d',dir,dir+'/SwitchOracle.java']);assert.equal(run('java',['-Xmx128m','-cp',dir,'SwitchOracle']),'46800');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('compiler exhaustive-switch reconstruction is opt-in',()=>{
 const finish=require('../src/decompiler/cfr')._internals.shareExistingExitTails,key='CFR_JS_EXHAUSTIVE_SWITCH_FRAME_EXITS',old=process.env[key],s='Exit:{if(test()){switch(x){case 1:one();break Exit;default:other();break Exit;}}fallback();}';
 try{delete process.env[key];let body=[s];finish(body);const baseline=body.join('\n');process.env[key]='1';body=[s];finish(body);assert.notEqual(body.join('\n'),baseline);assert.ok(body.join('\n').includes('else'));}finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}
});
