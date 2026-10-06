'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{foldTerminalFrameLoops:fold}=require('../src/decompiler/javaAstEmitter');const{shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;

test('normal emission uses ordinary exits for the terminal loop',()=>{
 const body=['Frame:{prefix();while(run()){if(stop())break Frame;work();}}'];finish(body);assert.equal(body[0],'prefix();while(run()){if(stop())break;work();}');assert.equal(fold(body[0]).framesRecovered,0);
});
test('all four loop forms preserve headers, declaration scopes and scalar slots',()=>{
 for(const source of['Frame:{prefix();for(int i=0;run();i++){if(stop())break Frame;work();}}','Frame:{prefix();for(Item item:items){if(stop())break Frame;work(item);}}','Frame:{prefix();do{if(stop())break Frame;work();}while(run());}',
 'Frame:{Object alias=read();while(run()){if(stop())break Frame;work(alias);}}','if(outer())Frame:{prefix();while(run()){if(stop())break Frame;work();}}else tail();']){const next=fold(source,{retainDiagnostics:true});assert.equal(next.framesRecovered,1,source);assert.equal(next.labelsRemoved,1);assert.equal(next.breaksLocalized,1);let current=next.source;for(let i=0;i<8;i++){const again=fold(current);if(!again.framesRecovered)break;assert.notEqual(again.source,current);current=again.source;}assert.equal(fold(current).framesRecovered,0);}
 assert.ok(fold('Frame:{Object alias=read();while(run()){if(stop())break Frame;work(alias);}}').source.startsWith('{Object alias=read();while'));
});
test('terminal branches and labels keep complete prefixes and other destinations',()=>{
 for(const source of['Frame:{if(outer()){prefix();while(run()){if(stop())break Frame;work();}}else other();}',
 'Frame:{Alias:{prefix();while(run()){if(stop())break Frame;if(other())break Alias;work();}}}',
 'Frame:{prefix();Outer:while(run()){if(again())continue Outer;if(stop())break Frame;work();}}']){const next=fold(source,{retainDiagnostics:true});assert.equal(next.framesRecovered,1,source);let current=next.source;for(let i=0;i<8;i++){const again=fold(current);if(!again.framesRecovered)break;assert.notEqual(again.source,current);current=again.source;}assert.equal(fold(current).framesRecovered,0);}
 const lifted=fold('Frame:{prefix();while(run()){while(next()){if(stop())break Frame;}}}');assert.equal(lifted.labelsLifted,1);assert.equal(lifted.labelsRemoved,0);assert.ok(lifted.source.includes('Frame: while'));
 const merged=fold('Frame:{prefix();Outer:while(run()){while(next()){if(stop())break Frame;}if(again())continue Outer;}}');assert.equal(merged.labelsMerged,1);assert.ok(merged.source.includes('break Outer;'));
 const next=fold('Frame:{prefix();Outer:while(run()){if(again())continue Outer;if(stop())break Frame;work();}}',{retainDiagnostics:true});assert.equal(next.breaksLocalized,1);assert.ok(next.source.includes('break;'));assert.ok(next.source.includes('continue Outer;'));
});
test('prefix references, extra work and crossed protected/iteration boundaries refuse',()=>{
 for(const source of['Frame:{if(stop())break Frame;while(run()){if(done())break Frame;work();}}',
 'Frame:{while(run()){if(stop())break Frame;work();}after();}',
 'Frame:{if(outer()){while(run()){if(stop())break Frame;work();}after();}}',
 'Frame:{try{while(run()){if(stop())break Frame;work();}}finally{cleanup();}}',
 'Frame:{try{return;}finally{while(run()){if(stop())break Frame;work();}}}',
 'Frame:{synchronized(lock){while(run()){if(stop())break Frame;work();}}}',
 'Frame:{while(run()){if(stop())continue Frame;work();}}',
 'Frame:{while(run()){if(stop())break Frame;Runnable r=()->work();}}',
 'Frame:{while(run()){if(stop())break Frame;work();}} //comment\n',
 'Frame:{while(run()){if(stop())break Frame;work();}}\\u000a',
 'Frame:{while(run()){if(stop())break Frame;work();}}'+' '.repeat(400001)])assert.equal(fold(source).source,source,source.slice(0,100));
});
test('diagnostics provide exact frame, loop, corridor and named transfer boundaries',()=>{
 const source='Frame:{if(outer()){prefix();do{if(stop())break Frame;work();}while(run());}}',next=fold(source,{retainDiagnostics:true}),d=next.diagnostics;assert.equal(next.framesRecovered,1);assert.equal(source.slice(d.loopRange.start,d.loopRange.end),'do{if(stop())break Frame;work();}while(run());');assert.equal(source.slice(d.labelRange.start,d.labelRange.end),'Frame:');assert.deepEqual(d.corridorKinds,['BlockStatement','IfStatement','BlockStatement']);assert.equal(d.transfers.length,1);assert.equal(source.slice(d.transfers[0].range.start,d.transfers[0].range.end),'break Frame;');assert.ok(!Object.hasOwn(fold(source),'diagnostics'));assert.equal(fold(source,{retainDiagnostics:1}).framesRecovered,0);
});
test('native terminal loops preserve headers, updates, aliases, exceptions and finally overrides',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-frame-loop-native-'));
 const run=(cmd,args)=>{const files=['out','err'].map(n=>path.join(directory,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const makers=[body=>`while(outer(boxed)){step++;${body}}`,body=>`for(int i=0;outer(boxed)&&i<3;i=advance(i)){step++;${body}}`,body=>`do{step++;${body}}while(outer(boxed));`,body=>`for(int item:items(boxed)){step++;${body}}`];
 const contexts=[s=>s,s=>`try{${s}}finally{event(7);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){event(6);${s}}`,s=>`try{${s}}catch(IllegalStateException error){event(8);if(error!=FAILURE)throw error;}finally{event(7);}`,s=>`try{synchronized(lock){event(6);${s}}}finally{event(7);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`try{${s}}finally{event(7);if(mode==1)break Frame;}`];
 const active='event(1);value=value+step;if(prefixAlias!=lock)throw new AssertionError();if(inject==1)throw FAILURE;for(int j=0;j<2;j++){event(2);if(selected)break Frame;if(j==0)continue;event(3);}if(inject==2)throw FAILURE;event(4);';
 try{let methods='',models=0;for(const make of makers)for(const protect of contexts)for(const merge of [false,true])for(const nestedExit of [false,true]){
   const direct=active.replace('for(int j=0;j<2;j++){event(2);if(selected)break Frame;if(j==0)continue;event(3);}','event(2);if(selected)break Frame;event(3);');
   const prefix='Object prefixAlias=lock;event(0);value=value+seed;if(inject==3)throw FAILURE;',actions=protect((nestedExit?active:direct)+(merge?'if(step<3)continue Outer;':'if(step<3)continue;'));
   const source='Frame:{'+prefix+(merge?'Outer:':'')+make(actions)+'}event(5);return snapshot();',next=fold(source);assert.equal(next.framesRecovered,1,source);assert.equal(next.frameScopesFlattened,0);
   const oracle='{'+prefix+'Exit:'+make(actions.replaceAll('break Frame','break Exit').replaceAll('continue Outer','continue Exit'))+'}event(5);return snapshot();';
   for(const[name,body]of[['old',source],['next',next.source],['oracle',oracle]])methods+=`static String ${name}${models}(Boolean boxed,boolean selected,int seed,int inject,int mode){${body}}\n`;models++;
  }
  const java=`public class TerminalFrameLoopNative{static int step,value,effects;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){effects=effects*31+n;trace.append((char)('a'+n));}static boolean outer(Boolean boxed){event(10);return boxed.booleanValue()&&step<3;}static int advance(int i){event(9);return i+1;}static int[] items(Boolean boxed){event(10);return boxed.booleanValue()?new int[]{1,2,3}:new int[0];}static String snapshot(){return step+":"+value+":"+effects+":"+trace;}
${methods}
static String take(int kind,int variant,Boolean boxed,boolean selected,int seed,int inject,int mode,boolean nullLock){step=0;value=seed;effects=seed;trace=new StringBuilder();lock=nullLock?null:new Object();String result;try{switch(kind){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(boxed,selected,seed,inject,mode):variant==1?next${i}(boxed,selected,seed,inject,mode):oracle${i}(boxed,selected,seed,inject,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable error){result=error==FAILURE?"failure":error==OVERRIDE?"override":error.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+snapshot();}
public static void main(String[]args){int cases=0;for(int kind=0;kind<${models};kind++)for(Boolean boxed:new Boolean[]{false,true,null})for(boolean selected:new boolean[]{false,true})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int inject=0;inject<4;inject++)for(int mode=0;mode<3;mode++)for(boolean nullLock:new boolean[]{false,true}){String want=take(kind,2,boxed,selected,seed,inject,mode,nullLock);for(int variant=0;variant<2;variant++){String got=take(kind,variant,boxed,selected,seed,inject,mode,nullLock);if(!want.equals(got))throw new AssertionError(kind+":"+variant+":"+boxed+":"+selected+":"+seed+":"+inject+":"+mode+":"+want+":"+got);}cases++;}System.out.println(cases+" cases / ${models} models");}}
`;
 const file=path.join(directory,'TerminalFrameLoopNative.java');fs.writeFileSync(file,java);run('javac',['--release','8','-d',directory,file]);assert.equal(run('java',['-Xmx128m','-cp',directory,'TerminalFrameLoopNative']),'69120 cases / 96 models');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
