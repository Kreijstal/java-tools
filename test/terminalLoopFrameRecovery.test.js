'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{foldTerminalLoopFrames:fold}=require('../src/decompiler/javaAstEmitter');
const{shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;

test('the normal emitter puts an existing terminal frame name on its loop',()=>{
 const source='while(run()){Frame:{while(next()){if(stop())break Frame;}work();}break;}',body=[source];finish(body);
 assert.equal(body[0],'Frame: while(run()){while(next()){if(stop())break Frame;}work();break;}');assert.equal(fold(body[0]).framesRecovered,0);
});

test('while, for, enhanced-for and do loops preserve headers and declaration scopes',()=>{
 for(const[source,expected]of[
  ['for(int i=0;more();i++){Frame:{if(stop())break Frame;work();}break;}','Frame: for(int i=0;more();i++){if(stop())break Frame;work();break;}'],
  ['for(Item item:items){Frame:{if(stop())break Frame;work(item);}break;}','Frame: for(Item item:items){if(stop())break Frame;work(item);break;}'],
  ['do{Frame:{if(stop())break Frame;work();}break;}while(next());','Frame: do{if(stop())break Frame;work();break;}while(next());'],
  ['while(run()){Frame:{int local=read();if(local==0)break Frame;work(local);}break;}','Frame: while(run()){{int local=read();if(local==0)break Frame;work(local);}break;}'],
 ])assert.equal(fold(source).source,expected,source);
});

test('existing outer loop names merge the equivalent frame and preserve other jumps',()=>{
 const source='Outer:while(run()){prefix();Frame:{if(again())continue Outer;if(stop())break Frame;work();}break;}',next=fold(source,{retainDiagnostics:true});
 assert.equal(next.source,'Outer:while(run()){prefix();if(again())continue Outer;if(stop())break Outer;work();break;}');assert.equal(next.labelsMerged,1);assert.equal(next.labelsLifted,0);assert.equal(next.breakTargetsRedirected,1);
 const d=next.diagnostics;assert.equal(source.slice(d.labelRange.start,d.labelRange.end),'Frame:');assert.equal(source.slice(d.outerLabelRange.start,d.outerLabelRange.end),'Outer:');for(const r of d.transfers)assert.equal(source.slice(r.labelRange.start,r.labelRange.end),'Frame');
});

test('nested exits and finally overrides remain inside the same whole protected constructs',()=>{
 for(const source of[
  'while(run()){Frame:{try{while(next()){if(stop())break Frame;}}finally{clean();}}break;}',
  'while(run()){Frame:{try{return;}finally{if(stop())break Frame;}}break;}',
  'while(run()){Frame:{synchronized(lock){switch(mode){case 0:if(stop())break Frame;break;default:work();}}}break;}',
 ]){const next=fold(source);assert.equal(next.framesRecovered,1);assert.equal(fold(next.source).framesRecovered,0);}
});

test('nonterminal work, labelled final exits, named continues and unsupported structure refuse',()=>{
 for(const source of[
  'while(run()){Frame:{if(stop())break Frame;}after();break;}',
  'Outer:while(run()){Frame:{if(stop())break Frame;}break Outer;}',
  'while(run()){Frame:{if(stop())break Frame;}}',
  'while(run()){Frame:{if(stop())continue Frame;}break;}',
  'while(run()){try{Frame:{if(stop())break Frame;}}finally{clean();}break;}',
  'while(run()){Frame:{if(stop())break Frame;Runnable r=()->work();}break;}',
  'while(run()){Frame:{if(stop())break Frame;}break;} //comment\n',
  'while(run()){Frame:{if(stop())break Frame;}break;}\\u000a',
  'while(run()){Frame:{if(stop())break Frame;}break;}'+' '.repeat(400001),
 ])assert.equal(fold(source).source,source,source.slice(0,90));
});

test('native loop/frame exits preserve update suppression, callback order, aliasing and finally priority',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-loop-frame-native-'));
 const run=(command,args)=>{const files=['out','err'].map(n=>path.join(directory,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(command,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const frame=body=>'Frame:{'+body+'}break;',makers=[body=>`while(outer()){event(0);step++;${body}}`,body=>`for(int i=0;i<3;i=advance(i)){event(0);step++;${body}}`,body=>`do{event(0);step++;${body}}while(outer());`,body=>`for(int item:new int[]{1,2,3}){event(0);step++;${body}}`];
 const contexts=[body=>body,body=>`try{${body}}finally{event(7);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,body=>`synchronized(lock){event(6);${body}}`,body=>`try{${body}}catch(IllegalStateException error){event(8);if(error!=FAILURE)throw error;}finally{event(7);}`,body=>`try{synchronized(lock){event(6);${body}}}finally{event(7);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,body=>`try{${body}}finally{event(7);if(inject==3)break Frame;}`];
 const actions='event(1);value=value+step;if(lock!=null){Object alias=lock;if(alias!=lock)throw new AssertionError();}for(int j=0;j<2;j++){event(2);if(inject==1)throw FAILURE;if(selected)break Frame;if(j==0)continue;event(3);}event(4);if(inject==2)throw FAILURE;';
 try{
  let methods='',models=0;for(const make of makers)for(const protect of contexts)for(const merge of [false,true]){
   const active=actions+(merge?'if(step<3&&inject==0)continue Outer;':'if(step<3&&inject==0)continue;');const source=(merge?'Outer:':'')+make(frame(protect(active)))+'return snapshot();',next=fold(source);assert.equal(next.framesRecovered,1,source);
   const oracle='Exit:'+make((protect(active)+'break;').replaceAll('break Frame','break Exit').replaceAll('continue Outer','continue Exit'))+'return snapshot();';
   for(const[name,body]of[['old',source],['next',next.source],['oracle',oracle]])methods+=`static String ${name}${models}(boolean selected,int inject,int mode){${body}}\n`;models++;
  }
  const java=`public class TerminalLoopFrameNative{static int step,value,effects;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){effects=effects*31+n;trace.append((char)('a'+n));}static boolean outer(){event(10);return step<3;}static int advance(int i){event(9);return i+1;}static String snapshot(){return step+":"+value+":"+effects+":"+trace;}
${methods}
static String take(int kind,int variant,boolean selected,int inject,int mode,boolean nullLock,int seed){step=0;value=seed;effects=seed;trace=new StringBuilder();lock=nullLock?null:new Object();String result;try{switch(kind){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(selected,inject,mode):variant==1?next${i}(selected,inject,mode):oracle${i}(selected,inject,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable failure){result=failure==FAILURE?"failure":failure==OVERRIDE?"override":failure.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+snapshot();}
public static void main(String[]args){int cases=0;for(int kind=0;kind<${models};kind++)for(boolean selected:new boolean[]{false,true})for(int inject=0;inject<4;inject++)for(int mode=0;mode<3;mode++)for(boolean nullLock:new boolean[]{false,true})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE}){String want=take(kind,2,selected,inject,mode,nullLock,seed);for(int variant=0;variant<2;variant++){String got=take(kind,variant,selected,inject,mode,nullLock,seed);if(!want.equals(got))throw new AssertionError(kind+":"+variant+":"+selected+":"+inject+":"+mode+":"+want+":"+got);}cases++;}System.out.println(cases+" cases / ${models} models");}}
`;
  const file=path.join(directory,'TerminalLoopFrameNative.java');fs.writeFileSync(file,java);run('javac',['--release','8','-d',directory,file]);assert.equal(run('java',['-Xmx128m','-cp',directory,'TerminalLoopFrameNative']),'11520 cases / 48 models');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
