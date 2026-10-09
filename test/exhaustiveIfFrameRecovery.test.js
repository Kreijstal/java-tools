'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {foldExhaustiveIfFrameExits:fold,reindentStructuredSource:indent}=require('../src/decompiler/javaAstEmitter');

test('direct frame exits become one ordered decision chain with exact scoped payloads',()=>{
 const s='Exit:{prefix();if(ready()){if(first()){int x=one();use(x);break Exit;}if(second()){two();break Exit;}last();break Exit;}fallback();}after();',r=fold(s,{retainDiagnostics:true});
 assert.equal(r.framesRecovered,1);assert.equal(r.breaksRemoved,3);assert.ok(!r.source.includes('Exit:'));assert.ok(!r.source.includes('break Exit'));assert.match(r.source,/else if\(second\(\)\)/);assert.match(r.source,/else \{last\(\);/);assert.match(r.source,/else \{fallback\(\);/);
 for(const call of ['prefix()','ready()','first()','second()','one()','use(x)','two()','last()','fallback()','after()'])assert.equal(r.source.split(call).length-1,1,call);
 let expected=s;for(const e of r.diagnostics.edits)expected=expected.slice(0,e.start)+e.text+expected.slice(e.end);assert.equal(expected,r.source);assert.equal(fold(r.source).framesRecovered,0);
});

test('whole protected actions and other transfers retain scope and destinations',()=>{
 const s='Exit:{if(ready()){if(first()){try{one();}finally{cleanup();}break Exit;}if(second()){synchronized(lock){while(next()){break;}}break Exit;}last();break Exit;}fallback();}';
 for(const body of [s,'try{'+s+'}finally{done();}','Outer:while(next()){'+s+'if(skip())continue Outer;}']){const r=fold(body);assert.equal(r.framesRecovered,1,body);assert.match(r.source,/try\{one\(\);\}finally\{cleanup\(\);\}/);assert.match(r.source,/while\(next\(\)\)\{break;\}/);}
});

test('nonterminal, protected, extra frame exits, captures and excessive ladders refuse',()=>{
 const base=(arms,tail='last();break Exit;',suffix='fallback();')=>'Exit:{if(ready()){'+arms+tail+'}'+suffix+'}';
 const arm=(condition,body)=>'if('+condition+'){'+body+'}';
 const good=arm('first()','one();break Exit;')+arm('second()','two();break Exit;');
 for(const s of [base(arm('first()','one();')+arm('second()','two();break Exit;')),base(arm('first()','try{one();break Exit;}finally{cleanup();}')+arm('second()','two();break Exit;')),base(good,'last();'),base(good,'if(skip())break Exit;last();break Exit;'),base(good,undefined,'if(skip())break Exit;fallback();'),base(good,undefined,'if(skip())continue Exit;'),base(good)+'Runnable r=()->one();',base(Array.from({length:65},(_,i)=>arm('choice('+i+')','one();break Exit;')).join('')),base(arm('first()','one();break Exit;'))])assert.equal(fold(s).source,s,s);
});

test('native ordered ladders preserve effectful predicates, aliases, partial stores and protection',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'exhaustive-if-native-'));
 const run=(command,args)=>{const files=['out','err'].map(n=>path.join(dir,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(command,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));for(const f of files)assert.ok(fs.statSync(f).size<=1024*1024);return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const wraps=[s=>s,s=>`try{${s}}finally{event(9);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){${s}}`,s=>`try{${s}}catch(IllegalStateException e){event(8);if(e!=FAILURE)throw e;}finally{event(9);}return snapshot();`];
 try{let methods='';for(let m=0;m<wraps.length;m++){
  const frame='Exit:{event(0);if(choice(guard)){if(match(selector,-1)){store(1);break Exit;}if(match(selector,0)){try{store(2);}finally{event(6);}break Exit;}if(match(selector,4)){synchronized(lock){store(4);}break Exit;}store(3);break Exit;}store(5);}event(7);return snapshot();',before=wraps[m](frame),after=fold(before);assert.equal(after.framesRecovered,1);assert.equal(after.breaksRemoved,4);
  const oracle=wraps[m]('event(0);event(10);if(guard==null)throw new NullPointerException();if(guard==Boolean.TRUE){event(11);if(selector==null)throw new NullPointerException();if(selector.intValue()==-1)store(1);else {event(11);if(selector.intValue()==0){try{store(2);}finally{event(6);}}else {event(11);if(selector.intValue()==4){synchronized(lock){store(4);}}else store(3);}}}else store(5);event(7);return snapshot();');
  for(const[n,s]of [['old',before],['next',indent(after.source).source],['oracle',oracle]])methods+=`static String ${n}${m}(Boolean guard,Integer selector,int mode){${s}}\n`;
 }
 const java=`public class IfOracle{static int value,count,failAt,index;static Object lock;static int[] array,alias;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){value=value*31+n;trace.append(n).append(Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}static boolean choice(Boolean x){event(10);return x.booleanValue();}static boolean match(Integer x,int expected){event(11);return x.intValue()==expected;}static void store(int n){event(n);alias[index]=value;}static String snapshot(){return value+":"+count+":"+trace+":"+(array==null?"null":java.util.Arrays.toString(array))+":"+(alias==array);}
 ${methods}
 static String take(int model,int variant,Boolean guard,Integer selector,int mode,int seed,int arrayMode){value=seed;count=0;trace=new StringBuilder();lock=new Object();array=arrayMode==0?null:new int[]{seed,seed};alias=array;index=arrayMode==2?-1:arrayMode==3?2:0;String result;try{switch(model){${wraps.map((_,m)=>`case ${m}:result=variant==0?old${m}(guard,selector,mode):variant==1?next${m}(guard,selector,mode):oracle${m}(guard,selector,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("lock leaked");return result+":"+snapshot();}
 public static void main(String[]args){int cases=0;for(int model=0;model<${wraps.length};model++)for(Boolean guard:new Boolean[]{false,true,null})for(Integer selector:new Integer[]{-1,0,4,7,null})for(int mode=0;mode<3;mode++)for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int arrayMode=0;arrayMode<4;arrayMode++)for(int failure=-1;failure<12;failure++){failAt=failure;String expected=take(model,2,guard,selector,mode,seed,arrayMode);for(int variant=0;variant<2;variant++){String actual=take(model,variant,guard,selector,mode,seed,arrayMode);if(!expected.equals(actual))throw new AssertionError(model+":"+guard+":"+selector+":"+mode+":"+seed+":"+arrayMode+":"+failure+":"+expected+":"+actual);}cases++;}System.out.println(cases);}}
 `;fs.writeFileSync(dir+'/IfOracle.java',java);run('javac',['--release','8','-d',dir,dir+'/IfOracle.java']);assert.equal(run('java',['-Xmx128m','-cp',dir,'IfOracle']),'46800');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('wide character decisions retain definite assignment and every primitive input',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'exhaustive-if-character-'));
 const run=(command,args)=>{const files=['out','err'].map(n=>path.join(dir,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(command,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 try {
  const source='int encoded;Exit:{if(character<64||character>192){'+Array.from({length:26},(_,i)=>`if(character==${i}){encoded=${i-120};break Exit;}`).join('')+'if(character!=255){encoded=63;break Exit;}encoded=-97;break Exit;}encoded=(byte)character;}return enabled?(byte)encoded:(byte)50;',next=fold(source);
  assert.equal(next.framesRecovered,1);assert.equal(next.breaksRemoved,28);
  const java=`public class CharacterOracle{static byte old(char character,boolean enabled){${source}}static byte next(char character,boolean enabled){${next.source}}static byte expected(int c,boolean enabled){if(!enabled)return 50;if(c>=64&&c<=192)return(byte)c;if(c<26)return(byte)(c-120);return c==255?(byte)-97:(byte)63;}public static void main(String[]args){int cases=0;for(int c=0;c<65536;c++)for(boolean enabled:new boolean[]{false,true}){byte wanted=expected(c,enabled);if(old((char)c,enabled)!=wanted||next((char)c,enabled)!=wanted)throw new AssertionError(c+":"+enabled);cases++;}System.out.println(cases);}}`;
  fs.writeFileSync(dir+'/CharacterOracle.java',java);run('javac',['--release','8','-d',dir,dir+'/CharacterOracle.java']);assert.equal(run('java',['-Xmx64m','-cp',dir,'CharacterOracle']),'131072');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('compiler ladder recovery is opt-in',()=>{
 const finish=require('../src/decompiler/cfr')._internals.shareExistingExitTails,key='CFR_JS_EXHAUSTIVE_IF_FRAME_EXITS',old=process.env[key],s='Exit:{if(ready()){'+Array.from({length:27},(_,i)=>'if(choice('+i+')){step('+i+');break Exit;}').join('')+'last();break Exit;}fallback();}';
 try{delete process.env[key];let body=[s];finish(body);const baseline=body.join('\n');process.env[key]='1';body=[s];finish(body);assert.notEqual(body.join('\n'),baseline);assert.ok(body.join('\n').includes('else'));}finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}
});
