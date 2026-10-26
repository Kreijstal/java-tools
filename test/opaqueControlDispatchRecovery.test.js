'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {recoverScalarIfDispatches:recover,reindentStructuredSource:indent}=require('../src/decompiler/javaAstEmitter');
const options={nestedRegions:true,opaqueControls:true};
const ladder=work=>`if(selected==1){one();}else if(selected==2){two();}else if(selected==3){${work}}else fallback();`;
test('protected local scopes and opaque loops retain their complete source actions',()=>{
 const work='try{for(index=0;index<limit();index++){step();if(stop())break;}}finally{cleanup();}';
 const source='try{int selected=read();Frame:{'+ladder(work)+'}after();}finally{finish();}';
 assert.equal(recover(source,{nestedRegions:true}).source,source);const next=recover(source,{...options,retainDiagnostics:true});assert.equal(next.dispatchesRecovered,1);assert.ok(next.source.includes(work));assert.equal(next.source.split('cleanup()').length-1,1);assert.equal(recover(next.source,options).dispatchesRecovered,0);
});
test('opaque switch destinations and bodies stay intact',()=>{
 for(const action of ['switch(other()){case 0:one();break;default:two();}', 'switch(other()){case 0:one();break;default:return done();}', 'switch(other()){case 0:return done();default:return done();}']){
  const source='int selected=read();Frame:{'+ladder(action)+'}after();',next=recover(source,options);assert.equal(next.dispatchesRecovered,1);assert.ok(next.source.includes(action));
 }
});
test('unknown completion, shadowing and external bare exits refuse',()=>{
 for(const action of ['try{while(true){step();}}finally{cleanup();}', 'try{for(;;){step();}}finally{cleanup();}', 'try{while(flag){step();}}finally{cleanup();}', 'try{while(more()){step();}}catch(RuntimeException selected){cleanup();}', 'if(guard())break;', 'try{do{return done();}while(more());}finally{cleanup();}']){
  const source='int selected=read();Outer:while(more()){Frame:{'+ladder(action)+'}after();}';assert.equal(recover(source,options).source,source,action);
 }
 const source='int selected=read();Frame:{'+ladder('step();')+'}';assert.equal(recover(source,{...options,opaqueControls:'yes'}).source,source);
});
test('native opaque controls match independent dispatch, conditional stores and protected completion',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opaque-controls-native-'));const run=(command,args)=>{const files=['out','err'].map(n=>path.join(dir,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(command,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const loop='try{for(index=0;index<limit();index++){store(10+index);if(stop())break;}}finally{event(18);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}',sw='switch(other()){case 0:store(20);break;case 1:store(21);break;default:store(22);}',unknown='if(nullable()){store(23);break Frame;}store(24);';
 const work=`int selected=select(input);Frame:{if(selected!=1){if(selected!=2){if(selected!=3){if(!permission())throw FAILURE;if(selected==4){${loop}}else if(selected==5){${sw}}else if(selected==6){store(6);}else{${unknown}}}else store(3);}else store(2);}else store(1);}event(7);return snapshot();`;
 const wraps=[s=>`try{${s}}finally{event(19);}`,s=>`synchronized(lock){try{${s}}finally{event(19);}}`];
 try{let methods='';for(let model=0;model<wraps.length;model++){
  const old=wraps[model](work);let next=old,count=0;for(;;){const r=recover(next,options);if(!r.dispatchesRecovered)break;next=r.source;count++;}assert.equal(count,2);
  const oracle=wraps[model]('int selected=select(input);if(selected>=1&&selected<=3)store(selected);else{if(!permission())throw FAILURE;if(selected==4){String early=oracleLoop();if(early!=null)return early;}else if(selected==5){int value=other();store(value==0?20:value==1?21:22);}else if(selected==6)store(6);else oracleUnknown();}event(7);return snapshot();');
  for(const[name,body]of[['old',old],['next',indent(next).source],['oracle',oracle]])methods+=`static String ${name}${model}(int input){${body}}\n`;
 }
 const java=`public class OpaqueOracle{static int value,count,failAt,index,mode,flag;static int[] array,alias;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){value=value*31+n;trace.append(n).append(Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}static int select(int n){event(0);return n;}static boolean permission(){event(9);return flag!=0;}static int limit(){event(12);return 3;}static boolean stop(){event(13);return mode==1;}static int other(){event(14);return mode;}static Boolean nullable(){event(15);return mode==2?null:mode==1;}static void store(int n){event(n);alias[index]=value;}static String snapshot(){return value+":"+count+":"+index+":"+trace+":"+(array==null?"null":java.util.Arrays.toString(array))+":"+(alias==array);}static String oracleLoop(){try{index=0;while(index<limit()){store(10+index);if(stop())break;index++;}}finally{event(18);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}return null;}static void oracleUnknown(){if(nullable()){store(23);return;}store(24);}
 ${methods}
 static String take(int model,int variant,int input,int control,int m,int seed,int arrayMode){value=seed;count=0;index=0;mode=m;flag=control;trace=new StringBuilder();lock=new Object();array=arrayMode==0?null:new int[]{seed,seed,seed};alias=array;String result;try{switch(model){${wraps.map((_,m)=>`case ${m}:result=variant==0?old${m}(input):variant==1?next${m}(input):oracle${m}(input);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+snapshot();}
 public static void main(String[]args){int cases=0;for(int model=0;model<${wraps.length};model++)for(int input:new int[]{Integer.MIN_VALUE,-1,0,1,2,3,4,5,6,7,Integer.MAX_VALUE})for(int control:new int[]{-1,0,1})for(int m=0;m<3;m++)for(int seed:new int[]{Integer.MIN_VALUE,0,Integer.MAX_VALUE})for(int arrayMode=0;arrayMode<2;arrayMode++)for(int failure=-1;failure<22;failure++){failAt=failure;String expected=take(model,2,input,control,m,seed,arrayMode);for(int variant=0;variant<2;variant++){String actual=take(model,variant,input,control,m,seed,arrayMode);if(!expected.equals(actual))throw new AssertionError(model+":"+variant+":"+input+":"+control+":"+m+":"+seed+":"+arrayMode+":"+failure+":"+expected+":"+actual);}cases++;}System.out.println(cases);}}
 `;fs.writeFileSync(dir+'/OpaqueOracle.java',java);run('javac',['--release','8','-d',dir,dir+'/OpaqueOracle.java']);assert.equal(run('java',['-Xmx128m','-cp',dir,'OpaqueOracle']),'27324');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('compiler recovers proved opaque dispatches by default',()=>{
 const finish=require('../src/decompiler/cfr')._internals.shareExistingExitTails,s='try{int selected=read();Frame:{'+ladder('try{while(more()){work();}}finally{cleanup();}').replace('fallback();','{if(guard()){if(other()){first();break Frame;}second();break Frame;}tail();}')+'}after();}finally{finish();}',body=[s];
 finish(body);assert.match(body.join('\n'),/switch \(selected\)/);
});
