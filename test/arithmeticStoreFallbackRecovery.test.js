'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {foldArithmeticStoreFallbacks:fold,foldSharedStoreFallbacks:plain,simplifyPredicateNegations:negate,simplifyPredicateGrouping:group,foldTerminalGuardedFrameExits:terminal}=require('../src/decompiler/javaAstEmitter');
const {shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;
const fields={owner:'Game',fields:[{name:'position',type:'int',static:false},{name:'wide',type:'long',static:true},{name:'floating',type:'float',static:false},{name:'boxed',type:'Integer',static:false}]};
const frame=rhs=>'Frame:{if(choose()){if(early())break Frame;prefix();if(keep())break Frame;}this.position='+rhs+';}';
test('integral arithmetic stores occupy exclusive arms while preserving other exits',()=>{
 const source=frame('this.position-1'),next=fold(source,{ownedFields:fields,retainDiagnostics:true});assert.equal(next.framesRecovered,1);assert.equal(next.sharedFramesRetained,1);assert.equal(next.labelsRemoved,0);assert.equal(next.fallbackIdentifierCopiesAdded,2);assert.equal(plain(source,{ownedFields:fields}).source,source);assert.equal(next.source,'Frame:{if(choose()){if(early())break Frame;prefix();if (!(keep())) {this.position=this.position-1;}} else {this.position=this.position-1;}}');
});
test('normal emission reconstructs computed assignments after earlier terminal cleanup',()=>{
 const source=frame('this.position-1'),body=[source];finish(body,[],[],fields);
 assert.equal(body[0],'if(choose()){if (!(early())) {prefix();if (!keep()) {this.position=this.position-1;}}} else {this.position=this.position-1;}');
});
test('integer promotion, shifts, division and original association remain explicit',()=>{
 for(const rhs of ['this.position+1','this.position*3-7','(this.position+1)*(this.position-3)','this.position/(1-this.position)','this.position%(1-this.position)','~this.position','this.position>>>33','this.position&7|this.position^3'])assert.equal(fold(frame(rhs),{ownedFields:fields}).framesRecovered,1,rhs);
 const source='int x=3;long y=5;Frame:{if(choose()){prefix();if(keep())break Frame;}x=x/2;y=(y*3L)>>(x+1);}';assert.equal(fold(source).fallbackAssignmentsCopied,2);
});
test('floating, boxing, casts, calls, increments and unknown/shadowed operands refuse',()=>{
 for(const rhs of ['this.floating+1','this.boxed+1','other.position-1','read()-1','this.position++','++this.position','(int)this.floating','array[index]-1','this.position+unknown','String.valueOf(this.position)','true?1:2'])assert.equal(fold(frame(rhs),{ownedFields:fields}).source,frame(rhs),rhs);
 const shadow='int position=0;{double position=1;'+frame('position-1')+'}';assert.equal(fold(shadow,{ownedFields:fields}).source,shadow);
 const crossed='Frame:{try{if(choose()){prefix();if(keep())break Frame;}this.position=this.position-1;}finally{cleanup();}}';assert.equal(fold(crossed,{ownedFields:fields}).source,crossed);
 assert.equal(fold(frame('this.position-1'),{ownedFields:fields,allowIntegralArithmetic:'yes'}).framesRecovered,1,'dedicated API fixes its arithmetic policy');
});
test('diagnostics clone only the complete bounded arithmetic sequence',()=>{
 const source=frame('(this.position+1)*(this.position-3)'),next=fold(source,{ownedFields:fields,retainDiagnostics:true}),d=next.diagnostics;assert.equal(source.slice(d.fallbackRange.start,d.fallbackRange.end),'this.position=(this.position+1)*(this.position-3);');assert.equal(d.segments.filter(s=>s.copy).length,1);assert.equal(next.fallbackIdentifierCopiesAdded,3);assert.equal(next.source.split('choose()').length-1,1);assert.equal(next.source.split('keep()').length-1,1);
});
test('native arithmetic fallbacks preserve overflow, division failure, volatile reads and partial writes',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arithmetic-fallback-native-'));
 const run=(cmd,args)=>{const out=path.join(directory,'out'),err=path.join(directory,'err'),fds=[out,err].map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(err,'utf8'));return fs.readFileSync(out,'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const contexts=[s=>s,s=>`try{${s}}finally{event(7);if(mode==1)return snap(x,y);if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){event(6);${s}}`,s=>`try{${s}}catch(ArithmeticException error){event(8);}finally{event(7);}`,s=>`try{synchronized(lock){event(6);${s}}}finally{event(7);if(mode==1)return snap(x,y);if(mode==2)throw OVERRIDE;}`,s=>`{Object alias=lock;${s}if(alias!=lock)throw new AssertionError();}`];
 const fallbacks=['x=x+seed;y=y/(seed-seed);','x=(x+1)*(x-3);y=(y*3L)>>(x+1);','counter=counter-1;x=x%seed;y=y^(x+seed);'];
 const prefix='event(1);x=x+seed;y=y-1;counter=counter+seed;if(inject==1)throw FAILURE;';
 try{let methods='',models=0;for(const protect of contexts)for(const nested of [false,true])for(const fallback of fallbacks){
  const active='if(probe(conditionBox)){if(early(earlyBox))break Frame;'+prefix+'if(keep(guardBox,inject))break Frame;}'+fallback;
  const source='int x=seed;long y=seed;'+protect('Frame:{'+(nested?'if(outer(outerBox)){'+active+'}':active)+'}event(3);')+'return snap(x,y);',next=fold(source,{parameters:[{name:'seed',type:'int'}],ownedFields:{owner:'ArithmeticNative',fields:[{name:'counter',type:'int',static:true}]}});assert.equal(next.framesRecovered,1);assert.equal(next.sharedFramesRetained,1);
  const select='boolean selected=probe(conditionBox);boolean use=true;if(selected){boolean leave=early(earlyBox);if(leave)use=false;else{'+prefix+'use=!keep(guardBox,inject);}}if(use){'+fallback+'}';
  const oracle='int x=seed;long y=seed;'+protect((nested?'if(outer(outerBox)){'+select+'}':select)+'event(3);')+'return snap(x,y);';
  let clean=next.source;for(;;){const result=negate(clean,{parameters:[{name:'seed',type:'int'}],ownedFields:{owner:'ArithmeticNative',fields:[{name:'counter',type:'int',static:true}]}});if(!result.predicatesSimplified)break;clean=result.source;}clean=group(clean).source;clean=terminal(clean).source;
  for(const[name,body]of [['old',source],['next',next.source],['clean',clean],['oracle',oracle]])methods+=`static String ${name}${models}(Boolean outerBox,Boolean conditionBox,Boolean earlyBox,Boolean guardBox,int seed,int inject,int mode){${body}}\n`;models++;
 }
 const java=`public class ArithmeticNative{static volatile int counter;static int effects;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){effects=effects*31+n;trace.append((char)('a'+n));}static boolean outer(Boolean b){event(10);return b.booleanValue();}static boolean probe(Boolean b){event(0);return b.booleanValue();}static boolean early(Boolean b){event(5);return b.booleanValue();}static boolean keep(Boolean b,int inject){event(2);if(inject==2)throw FAILURE;return b.booleanValue();}static String snap(int x,long y){return x+":"+y+":"+effects+":"+counter+":"+trace;}
${methods}
static String take(int kind,int variant,Boolean outerBox,Boolean conditionBox,Boolean earlyBox,Boolean guardBox,int seed,int inject,int mode,boolean nullLock){effects=seed;counter=seed;trace=new StringBuilder();lock=nullLock?null:new Object();String result;try{switch(kind){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(outerBox,conditionBox,earlyBox,guardBox,seed,inject,mode):variant==1?next${i}(outerBox,conditionBox,earlyBox,guardBox,seed,inject,mode):variant==2?clean${i}(outerBox,conditionBox,earlyBox,guardBox,seed,inject,mode):oracle${i}(outerBox,conditionBox,earlyBox,guardBox,seed,inject,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable error){result=error==FAILURE?"failure":error==OVERRIDE?"override":error.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+effects+":"+counter+":"+trace;}
public static void main(String[]args){int cases=0;for(int kind=0;kind<${models};kind++)for(Boolean outerBox:new Boolean[]{false,true,null})for(Boolean conditionBox:new Boolean[]{false,true,null})for(Boolean earlyBox:new Boolean[]{false,true,null})for(Boolean guardBox:new Boolean[]{false,true,null})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int inject=0;inject<3;inject++)for(int mode=0;mode<3;mode++)for(boolean nullLock:new boolean[]{false,true}){String expected=take(kind,3,outerBox,conditionBox,earlyBox,guardBox,seed,inject,mode,nullLock);for(int variant=0;variant<3;variant++)if(!take(kind,variant,outerBox,conditionBox,earlyBox,guardBox,seed,inject,mode,nullLock).equals(expected))throw new AssertionError(kind+":"+variant+":"+seed);cases++;}System.out.println(cases+" cases, ${models} models");}}
`;fs.writeFileSync(path.join(directory,'ArithmeticNative.java'),java);run('javac',['-d',directory,path.join(directory,'ArithmeticNative.java')]);assert.equal(run('java',['-Xmx128m','-cp',directory,'ArithmeticNative']),'262440 cases, 36 models');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
