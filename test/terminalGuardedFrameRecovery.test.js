'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{foldTerminalGuardedFrameExits:fold}=require('../src/decompiler/javaAstEmitter');const{shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;
const fixed=source=>{let guards=0,labels=0;for(;;){const next=fold(source,{retainDiagnostics:true});if(!next.guardsRecovered)return{source,guards,labels};source=next.source;guards++;labels+=next.labelsRemoved;}};

test('normal emission guards a complete terminal suffix without copying predicates or actions',()=>{
 const body=['Frame:{before();if(stop())break Frame;work();after();}'];finish(body);assert.equal(body[0],'before();if (!(stop())) {work();after();}');assert.equal(fold(body[0]).guardsRecovered,0);
});
test('terminal if arms and declaration/scalar scopes keep every condition once',()=>{
 for(const source of['Frame:{if(outer()){before();if(stop())break Frame;int x=read();work(x);}}',
 'Frame:{if(outer()){other();}else{if(stop())break Frame;work();}}',
 'Frame:{int x=read();if(stop())break Frame;work(x);}',
 'if(outer())Frame:{if(stop())break Frame;work();}else other();']){const next=fold(source,{retainDiagnostics:true});assert.equal(next.guardsRecovered,1,source);assert.equal(next.labelsRemoved,1);assert.equal(next.source.split('stop()').length-1,1);assert.equal(fold(next.source).guardsRecovered,0);}
 assert.ok(fold('Frame:{int x=read();if(stop())break Frame;work(x);}').source.startsWith('{int x=read();'));
});
test('last guards recover first while remaining prefix/suffix exits keep their frame',()=>{
 const source='Frame:{if(first())break Frame;before();if(last())break Frame;work();}',one=fold(source,{retainDiagnostics:true});assert.equal(one.labelsRemoved,0);assert.equal(one.diagnostics.labelRetained,true);assert.ok(one.source.includes('if (!(last()))'));assert.ok(one.source.includes('if(first())break Frame;'));const result=fixed(source);assert.equal(result.guards,2);assert.equal(result.labels,1);assert.equal(result.source,'if (!(first())) {before();if (!(last())) {work();}}');
 const nested='Frame:{if(stop())break Frame;while(run()){if(done())break Frame;work();}}';assert.equal(fold(nested).labelsRemoved,0);assert.equal(fold(fold(nested).source).guardsRecovered,0);
});
test('whole protected suffixes remain together; crossed protected/loop corridors and extra work refuse',()=>{
 for(const suffix of['try{work();}finally{cleanup();}','synchronized(lock){work();}','try{work();}catch(Exception error){handle(error);}finally{cleanup();}'])assert.equal(fold('Frame:{if(stop())break Frame;'+suffix+'}').guardsRecovered,1);
 for(const source of['Frame:{if(outer()){if(stop())break Frame;work();}after();}',
  'Frame:{while(run()){if(stop())break Frame;work();}}','Frame:{try{if(stop())break Frame;work();}finally{cleanup();}}',
  'Frame:{synchronized(lock){if(stop())break Frame;work();}}','Frame:{if(stop())break Frame;}',
  'Frame:{if(stop()){before();break Frame;}work();}','Frame:{if(stop())continue Frame;work();}',
  'Frame:{if(stop())break Frame;work();} //comment\n','Frame:{if(stop())break Frame;work();}\\u000a',
  'Frame:{if(stop())break Frame;Runnable r=()->work();}','Frame:{if(stop())break Frame;work();}'+' '.repeat(400001)])assert.equal(fold(source).source,source,source.slice(0,100));
});
test('diagnostics certify the complete terminal corridor, original guard, suffix and retained label',()=>{
 const source='Frame:{if(outer()){before();if(stop()){break Frame;}work();after();}}',next=fold(source,{retainDiagnostics:true}),d=next.diagnostics;assert.deepEqual(d.corridorKinds,['IfStatement','BlockStatement']);assert.equal(source.slice(d.jumpRange.start,d.jumpRange.end),'break Frame;');assert.equal(source.slice(d.conditionRange.start,d.conditionRange.end),'(stop())');assert.equal(source.slice(d.suffixRange.start,d.suffixRange.end),'work();after();');assert.equal(d.suffixStatements,2);assert.equal(d.labelRetained,false);assert.ok(!Object.hasOwn(fold(source),'diagnostics'));assert.equal(fold(source,{retainDiagnostics:1}).guardsRecovered,0);
});
test('native terminal suffixes preserve nullable guards, partial writes, aliasing, nested exits and finally priority',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-guard-frame-native-'));
 const run=(cmd,args)=>{const files=['out','err'].map(n=>path.join(directory,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const contexts=[s=>s,s=>`try{${s}}finally{event(7);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){event(6);${s}}`,s=>`try{${s}}catch(IllegalStateException error){event(8);if(error!=FAILURE)throw error;}finally{event(7);}`,s=>`try{synchronized(lock){event(6);${s}}}finally{event(7);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`{Object prefixAlias=lock;${s}if(prefixAlias!=lock)throw new AssertionError();}`];
 const prefix='event(0);value=value+seed;if(inject==1)throw FAILURE;',suffix='event(2);value=value-1;Object alias=lock;if(alias!=lock)throw new AssertionError();if(inject==2)throw FAILURE;for(int j=0;j<2;j++){event(3);if(j==0)continue;if(inject==3)break;}event(4);';
 try{let methods='',models=0;for(const protect of contexts)for(const nested of [false,true])for(const chain of [false,true]){
   const active=prefix+'if(stop(boxed))break Frame;'+(chain?'event(5);if(stop(other))break Frame;':'')+suffix;
   const source=protect('Frame:{'+(nested?'if(outer(outerBox)){'+active+'}':active)+'}event(9);')+'return snapshot();',next=fixed(source);assert.equal(next.guards,chain?2:1,source);assert.equal(next.labels,1);
   const body=prefix+'boolean selected=stop(boxed);if(!selected){'+(chain?'event(5);boolean again=stop(other);if(!again){'+suffix+'}':suffix)+'}';
   const oracle=protect((nested?'if(outer(outerBox)){'+body+'}':body)+'event(9);')+'return snapshot();';for(const[name,code]of[['old',source],['next',next.source],['oracle',oracle]])methods+=`static String ${name}${models}(Boolean outerBox,Boolean boxed,Boolean other,int seed,int inject,int mode){${code}}\n`;models++;
  }
  const java=`public class TerminalGuardNative{static int value,effects;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){effects=effects*31+n;trace.append((char)('a'+n));}static boolean stop(Boolean b){event(1);return b.booleanValue();}static boolean outer(Boolean b){event(10);return b.booleanValue();}static String snapshot(){return value+":"+effects+":"+trace;}
${methods}
static String take(int kind,int variant,Boolean outerBox,Boolean boxed,Boolean other,int seed,int inject,int mode,boolean nullLock){value=seed;effects=seed;trace=new StringBuilder();lock=nullLock?null:new Object();String result;try{switch(kind){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(outerBox,boxed,other,seed,inject,mode):variant==1?next${i}(outerBox,boxed,other,seed,inject,mode):oracle${i}(outerBox,boxed,other,seed,inject,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable error){result=error==FAILURE?"failure":error==OVERRIDE?"override":error.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+snapshot();}
public static void main(String[]args){int cases=0;for(int kind=0;kind<${models};kind++)for(Boolean outerBox:new Boolean[]{false,true,null})for(Boolean boxed:new Boolean[]{false,true,null})for(Boolean other:new Boolean[]{false,true,null})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int inject=0;inject<4;inject++)for(int mode=0;mode<3;mode++)for(boolean nullLock:new boolean[]{false,true}){String want=take(kind,2,outerBox,boxed,other,seed,inject,mode,nullLock);for(int variant=0;variant<2;variant++){String got=take(kind,variant,outerBox,boxed,other,seed,inject,mode,nullLock);if(!want.equals(got))throw new AssertionError(kind+":"+variant+":"+outerBox+":"+boxed+":"+other+":"+seed+":"+inject+":"+mode+":"+want+":"+got);}cases++;}System.out.println(cases+" cases / ${models} models");}}
`;
  const file=path.join(directory,'TerminalGuardNative.java');fs.writeFileSync(file,java);run('javac',['--release','8','-d',directory,file]);assert.equal(run('java',['-Xmx128m','-cp',directory,'TerminalGuardNative']),'77760 cases / 24 models');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
