'use strict';
const test=require('node:test');
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{spawnSync}=require('child_process');
const {specializePathGuards:fold}=require('../src/decompiler/javaAstEmitter');
const {simplifyControlFrames:clean}=require('../src/decompiler/javaAstEmitter');
function recover(source){let changes=0;for(let limit=0;limit<128;limit++){const next=fold(source);if(!next.guardsSpecialized)break;source=next.source;changes++;}return{source,changes};}
test('native path guards preserve selection, mutations, transfers, cleanup and monitors',()=>{
const variants=[
 'int guard=mode;if(guard==0){step("A");if(guard==0){step("B");}}step("tail");',
 'int guard=mode;if(guard==0){step("A");if(guard!=0){step("bad");}}step("tail");',
 'int guard=mode;if(guard!=0)return;step("A");if(guard==0)return;step("bad");',
 'int guard=mode;Exit:{if(guard!=0)break Exit;step("A");if(guard==0)break Exit;step("bad");}step("tail");',
 'int guard=mode;for(int index=0;index<3;index++){if(guard!=0)break;step("A"+index);if(guard==0)continue;step("bad");}step("tail");',
 'int guard=mode;Outer:for(int index=0;index<3;index++){if(guard!=0)break;for(int inner=0;inner<3;inner++){step("A"+inner);if(guard==0)continue Outer;step("bad");}}step("tail");',
 'int guard=mode;while(more()){if(guard!=0)break;step("A");if(guard==0)continue;step("bad");}step("tail");',
 'int guard=mode;while(true){if(!more())break;if(guard!=0)break;step("A");if(guard==0)continue;step("bad");}step("tail");',
 'int guard=mode;try {if(guard!=0)return;step("A");if(guard==0)return;step("bad");}finally{cleanup();}',
 'int guard=mode;try {if(guard!=0)return;step("A");if(guard==0)return;step("bad");}catch(java.lang.RuntimeException failure){step("caught");}finally{cleanup();}',
 'int guard=mode;Exit:{try {if(guard!=0)break Exit;step("A");if(guard==0)break Exit;step("bad");}finally{cleanup();}}step("tail");',
 'int guard=mode;synchronized(lock){if(guard!=0)return;step("A"+Thread.holdsLock(lock));if(guard==0)return;step("bad");}',
 'int guard=mode;if(guard==0){step("A");if(guard==0)throw specific;step("bad");}step("tail");',
 'int guard=mode;int other=input;if(guard==0&&other==1){step("A");if(guard!=0||other!=1){step("bad");}}step("tail");',
 'int guard=mode;int other=input;if(guard!=0||other!=1){step("A");}else{if(guard==0&&other==1){step("B");}}step("tail");',
 'int guard=mode;if(guard==0&&predicate()){step("A");if(guard!=0){step("bad");}}step("tail");',
 'int guard=mode;if(guard==0){guard=input;step("A");if(guard==0){step("B");}}step("tail");',
 'int guard=mode;Exit:{if(guard!=0)break Exit;guard=input;step("A");if(guard==0){step("B");}}step("tail");',
 'int guard=mode;try{if(guard==0){step("A");if(guard==0){step("B");}}}finally{guard=input;step("cleanup");if(guard==0)step("C");}',
 'int guard=mode;Exit:{if(guard==0){step("A");if(guard!=0)break Exit;}step("B");}step("tail");',
 'int guard=mode;int other=input;Outer:{if(guard==0){step("A");if(guard==0){if(other==1)break Outer;else return;}step("bad");}}step("tail");',
 'int guard=mode;int other=input;try {if(guard==0){step("A");if(guard==0)return;step("bad");}}finally{if(other==1)throw fatal;cleanup();}',
 'int guard=mode;do{if(guard!=0)break;step("A");if(guard==0)continue;step("bad");}while(false);step("tail");'
];
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'path-guards-native-')),methods=[];let changed=0;
function run(command,args){const files=['stdout','stderr'].map(n=>path.join(directory,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(command,args,{stdio:['ignore',...fds],timeout:15000,env:{...process.env,JAVA_TOOL_OPTIONS:'-XX:-UsePerfData'}});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8');}finally{fds.forEach(fd=>fs.closeSync(fd));}}
try{
 variants.forEach((source,index)=>{const next=recover(source);if(index>=16&&index<=18)assert.equal(next.changes,0,index+' mutation must invalidate facts');else assert.ok(next.changes>0,index+' should reconstruct');changed+=next.changes;let cleaned=next.source;for(;;){const n=clean(cleaned);if(n.source===cleaned)break;cleaned=n.source;}for(const[name,text]of[['original',source],['rebuilt',next.source],['cleaned',cleaned]])methods.push(`static void ${name}${index}(int mode,int input){${text}}`);});
 const java=`public class PathGuards {
 static StringBuilder trace;static int failures,effects,cleanups,ticks;static Object lock;static final RuntimeException specific=new IllegalArgumentException();static final Error fatal=new AssertionError();
 static void step(String s){trace.append(s).append('/');effects++;if(failures==1&&effects==1||failures==2&&effects==2)throw specific;}
 static void cleanup(){trace.append("cleanup/");cleanups++;if(failures==3)throw fatal;}
 static boolean more(){trace.append("tick/");return ticks++<3;}
 static boolean predicate(){trace.append("predicate/");return true;}
 ${methods.join('\n')}
 interface Call{void run();}
 static String invoke(Call call,boolean nullLock){trace=new StringBuilder();effects=0;cleanups=0;ticks=0;lock=nullLock?null:new Object();String result;try{call.run();result="ok";}catch(Throwable e){result=e==specific?"specific":e==fatal?"fatal":e.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("lock retained");return result+":"+effects+":"+cleanups+":"+trace;}
 static void oracle(Call call,String expected){String actual=invoke(call,false);if(!expected.equals(actual))throw new AssertionError(expected+" != "+actual);}
 public static void main(String[]args){int comparisons=0;
 oracle(()->cleaned0(0,0),"ok:3:0:A/B/tail/");
 oracle(()->cleaned0(7,0),"ok:1:0:tail/");
 oracle(()->cleaned1(0,0),"ok:2:0:A/tail/");
 oracle(()->cleaned3(0,0),"ok:2:0:A/tail/");
 oracle(()->cleaned4(0,0),"ok:4:0:A0/A1/A2/tail/");
 oracle(()->cleaned5(0,0),"ok:4:0:A0/A0/A0/tail/");
 oracle(()->cleaned8(0,0),"ok:1:1:A/cleanup/");
 oracle(()->cleaned11(0,0),"ok:1:0:Atrue/");
 oracle(()->cleaned12(0,0),"specific:1:0:A/");
 oracle(()->cleaned15(0,0),"ok:2:0:predicate/A/tail/");
 oracle(()->cleaned16(0,7),"ok:2:0:A/tail/");
 oracle(()->cleaned22(0,0),"ok:2:0:A/tail/");
 for(failures=0;failures<5;failures++)for(int mode:new int[]{Integer.MIN_VALUE,-1,0,1,7,Integer.MAX_VALUE})for(int input:new int[]{Integer.MIN_VALUE,-1,0,1,7,Integer.MAX_VALUE})for(boolean nullLock:new boolean[]{false,true}){
 ${variants.flatMap((_,i)=>['rebuilt','cleaned'].map(name=>`{String expected=invoke(()->original${i}(mode,input),nullLock),actual=invoke(()->${name}${i}(mode,input),nullLock);if(!expected.equals(actual))throw new AssertionError("${name}${i}:"+failures+":"+mode+":"+input+":"+nullLock+":"+expected+" != "+actual);comparisons++;}`)).join('\n')}
 }if(comparisons!=16560)throw new AssertionError(comparisons);System.out.println("path-guards-native:"+comparisons);
 }
 }`;
 const sourceFile=path.join(directory,'PathGuards.java');fs.writeFileSync(sourceFile,java);run('javac',['--release','8','-d',directory,sourceFile]);console.log(run('java',['-cp',directory,'PathGuards']).trim(),'guards reconstructed',changed);
}finally{fs.rmSync(directory,{recursive:true,force:true});}

});

test('path guards use preceding local comparisons and keep their selected scope',()=>{
 for(const source of [
  'int guard=mode;if(guard==0){if(guard==0){step("yes");}}',
  'int guard=mode;if(guard!=0){step("other");}else{if(guard==0){step("yes");}}',
  'int guard=mode;if(guard!=0)return;step("yes");if(guard==0)return;step("unreachable");',
  'int guard=mode;Exit:{if(guard!=0)break Exit;if(guard==0)break Exit;step("unreachable");}step("tail");',
  'int guard=mode;if(guard==0){if(guard!=0)step("unreachable");step("yes");}',
  'int guard=mode;int other=input;if(guard==0&&other==1){if(!(guard!=0||other!=1)){step("yes");}}',
  'int guard=mode;if(guard==0&&predicate()){if(guard==0){step("yes");}}',
  'final int guard=mode;if(guard==0){if(guard==0){step("yes");}}',
  'int guard=mode;if(guard==0){if(guard==0){int local=1;step(local);}}',
 ]){const next=fold(source);assert.equal(next.guardsSpecialized,1,source);assert.ok(!Object.hasOwn(next,'diagnostics'));}
 const next=fold('int guard=mode;if(guard!=0)return;if(guard==0)return;step("unreachable");');
 assert.ok(!next.source.includes('unreachable'));assert.ok(next.source.endsWith('}'),'wrapper suffix survives method-tail pruning');
 const multiline='int guard=mode;\nif(guard==0){\n  if(guard!=0){\n    step("unreachable");\n  }\n  step("yes");\n}\n';
 const vacant=fold(multiline);assert.equal(vacant.guardsSpecialized,1);
 assert.ok(!/^[ \t]+$/m.test(vacant.source),'deleting a guard leaves no whitespace-only line');
 assert.ok(!vacant.source.includes('unreachable'));
});

test('unproven writes, field/boxed types, declaration loss and checked catches refuse simplification',()=>{
 const original='int guard=mode;if(guard==0){if(guard==0){step("yes");}}';
 for(const source of [
  original.replace('int guard=mode;',''),
  original.replace('int guard','Integer guard'),
  original.replace('int guard','long guard'),
  original.replace('int guard','float guard'),
  original.replace('int guard','@Mark int guard'),
  original.replace('int guard','volatile int guard'),
  original.replaceAll('guard==0','this.guard==0'),
  original.replaceAll('guard==0','guard++==0'),
  original.replaceAll('guard==0','guard+0==0'),
  original.replaceAll('guard==0','guard==00'),
  original.replaceAll('guard==0','guard==0L'),
  original.replace('if(guard==0){if(guard==0)', 'if(guard==0){guard=input;if(guard==0)'),
  original+'guard=input;',
  original+'for(int index=0;index<2;index++){guard=index;}',
  original+'{int guard=0;}',
  original.replace('int guard=mode;','{int guard=mode;}'),
  'while(more()){'+original+'}',
  original.replace('if(guard==0){step("yes");}', 'if(guard==0){step("yes");}else{int local=1;step(local);}'),
  'int guard=mode;if(guard!=0)return;if(guard==0)return;int local=0;step(local);',
  'int guard=mode;try{if(guard==0){if(guard==0)step("yes");}checked();}catch(java.io.IOException failure){step("caught");}',
  original+'switch(input){case 0:break;default:break;}',
  'int guard=mode;while(running){if(guard==0){if(guard==0)step("yes");}}',
  original.replace('step("yes");','step("yes")'),
  original.replace('int guard=mode;','int guard=mode'),
  original+' return',
  original+' throw failure',
  original+' assert true',
  original.replace('step("yes");','1+2;'),
  original+' // comment\n',
  original.replaceAll('guard==0','\\u0067uard==0'),
  original+'Runnable task=()->step("task");',
  original+'class Local {void run(){step("local");}}',
 ])assert.deepEqual(fold(source),{source,guardsSpecialized:0},source);
 const noAssumption='int guard=mode;if(guard==0){step("zero");}else{step("nonzero");}';
 assert.deepEqual(fold(noAssumption),{source:noAssumption,guardsSpecialized:0},'no default flag value assumed');
});

test('optional diagnostics separate selected bytes from removed predicates and suffixes',()=>{
 const source='int guard=mode;if(guard!=0)return;if(guard==0){return;}step("unreachable");';
 const next=fold(source,{retainDiagnostics:true});assert.equal(next.guardsSpecialized,1);
 const d=next.diagnostics;assert.equal(d.known,true);assert.equal(d.condition,'guard==0');
 assert.equal(source.slice(d.edit.selectedStart,d.edit.selectedEnd),'{return;}');
 assert.equal(source.slice(d.edit.start,d.edit.end),'if(guard==0){return;}');
 assert.ok(d.removedRanges.some(r=>source.slice(r.start,r.end).includes('guard==0')));
 assert.ok(d.prunedRanges.some(r=>source.slice(r.start,r.end).includes('unreachable')));
 for(const r of d.removedRanges)assert.ok(r.start>=0&&r.end<=source.length&&r.start<=r.end);
});
