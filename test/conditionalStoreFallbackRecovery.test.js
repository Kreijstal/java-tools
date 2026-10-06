'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {foldConditionalStoreFallbacks:fold,foldArithmeticStoreFallbacks:arithmetic,foldTerminalGuardedFrameExits:terminal}=require('../src/decompiler/javaAstEmitter');
const {shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;
const fields={owner:'Game',fields:[{name:'position',type:'int',static:false}]};
const frame=suffix=>'Frame:{if(choose()){if(early())break Frame;prefix();if(keep())break Frame;}'+suffix+'}';
const suffix='this.position=this.position+1;if(post()){this.position=this.position-1;}';
test('whole conditional primitive continuations occupy exclusive arms without duplicating runtime evaluation',()=>{
 const source=frame(suffix),next=fold(source,{ownedFields:fields,retainDiagnostics:true});assert.equal(next.framesRecovered,1);assert.equal(next.sharedFramesRetained,1);assert.equal(next.fallbackAssignmentsCopied,2);assert.equal(next.fallbackConditionsCopied,1);assert.equal(arithmetic(source,{ownedFields:fields}).source,source);assert.equal(next.source,'Frame:{if(choose()){if(early())break Frame;prefix();if (!(keep())) {this.position=this.position+1;if(post()){this.position=this.position-1;}}} else {this.position=this.position+1;if(post()){this.position=this.position-1;}}}');assert.equal(terminal(next.source).labelsRemoved,1);
});
test('normal emission recovers a complete conditional continuation',()=>{
 const body=[frame(suffix)];finish(body,[],[],fields);
 assert.equal(body[0],'Frame:{if(choose()){if(early())break Frame;prefix();if (!(keep())) {this.position=this.position+1;if(post()){this.position=this.position-1;}}} else {this.position=this.position+1;if(post()){this.position=this.position-1;}}}');
});
test('braced/scalar if/else trees, boolean stores and original expression association remain explicit',()=>{
 for(const tail of ['this.position=1;if(post())this.position=2;','if(post()){this.position=1;}else{this.position=2;}','this.position=0;if(first()){if(second())this.position=1;else this.position=2;}'])assert.equal(fold(frame(tail),{ownedFields:fields}).framesRecovered,1,tail);
 assert.equal(fold('boolean b=false;Frame:{if(choose()){prefix();if(keep())break Frame;}if(post())b=true;else b=false;}').fallbackAssignmentsCopied,2);
});
test('declarations, protected regions, loops, transfers, floating/call stores and budgets refuse',()=>{
 for(const tail of ['if(post()){int position=1;}','if(post()){while(run())this.position=1;}','if(post())break Frame;','if(post())return;','try{this.position=1;}finally{cleanup();}','if(post())this.position=read();','if(post())this.position=(int)floating;','if(post())this.position=this.position+1.0;','this.position=1;'.repeat(9)])assert.equal(fold(frame(tail),{ownedFields:fields}).source,frame(tail),tail);
 const deep='if(post()){'.repeat(6)+'this.position=1;'+'}'.repeat(6);assert.equal(fold(frame(deep),{ownedFields:fields}).source,frame(deep));
 const prefix='Frame:{if(choose()){int position=0;if(keep())break Frame;}if(post())this.position=1;}';assert.equal(fold(prefix,{ownedFields:fields}).source,prefix);
});
test('diagnostics clone the complete suffix with every condition and store in original order',()=>{
 const source=frame(suffix),next=fold(source,{ownedFields:fields,retainDiagnostics:true}),d=next.diagnostics;assert.equal(source.slice(d.fallbackRange.start,d.fallbackRange.end),suffix);assert.equal(d.segments.filter(s=>s.copy).length,1);assert.equal(next.fallbackIdentifierCopiesAdded,5);assert.equal(next.source.split('choose()').length-1,1);assert.equal(next.source.split('keep()').length-1,1);
});
test('native conditional continuations preserve nullable predicates, callback order, partial writes and protected completion',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'conditional-fallback-native-'));
 const run=(cmd,args)=>{const out=path.join(directory,'out'),err=path.join(directory,'err'),fds=[out,err].map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(err,'utf8'));return fs.readFileSync(out,'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const contexts=[s=>s,s=>`try{${s}}finally{event(7);if(mode==1)return snap(x,y);if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){event(6);${s}}`,s=>`try{${s}}catch(ArithmeticException error){event(8);}finally{event(7);}`,s=>`try{synchronized(lock){event(6);${s}}}finally{event(7);if(mode==1)return snap(x,y);if(mode==2)throw OVERRIDE;}`,s=>`{Object alias=lock;${s}if(alias!=lock)throw new AssertionError();}`];
 const fallbacks=[
 ['x=x+seed;if(post(postBox,inject)){y=y/(seed-seed);}', 'x=x+seed;boolean tail=post(postBox,inject);if(tail)y=y/(seed-seed);'],
 ['x=(x+1)*(x-3);if(post(postBox,inject))y=(y*3L)>>(x+1);else counter=counter-1;', 'x=(x+1)*(x-3);boolean tail=post(postBox,inject);if(tail)y=(y*3L)>>(x+1);else counter=counter-1;'],
 ['counter=counter-1;if(post(postBox,inject)&&post(postBox,inject)){x=x%seed;y=y^(x+seed);}', 'counter=counter-1;boolean first=post(postBox,inject);boolean tail=false;if(first)tail=post(postBox,inject);if(tail){x=x%seed;y=y^(x+seed);}'],
 ];
 const prefix='event(1);x=x+seed;y=y-1;counter=counter+seed;if(inject==1)throw FAILURE;';
 try{let methods='',models=0;for(const protect of contexts)for(const nested of [false,true])for(const [fallback,oracleTail]of fallbacks){
  const active='if(probe(conditionBox)){if(early(earlyBox))break Frame;'+prefix+'if(keep(guardBox,inject))break Frame;}'+fallback;
  const source='int x=seed;long y=seed;'+protect('Frame:{'+(nested?'if(outer(outerBox)){'+active+'}':active)+'}event(3);')+'return snap(x,y);',next=fold(source,{parameters:[{name:'seed',type:'int'}],ownedFields:{owner:'ConditionalNative',fields:[{name:'counter',type:'int',static:true}]}});assert.equal(next.framesRecovered,1);assert.equal(next.sharedFramesRetained,1);const clean=terminal(next.source);assert.equal(clean.labelsRemoved,1);
  const select='boolean selected=probe(conditionBox);boolean use=true;if(selected){boolean leave=early(earlyBox);if(leave)use=false;else{'+prefix+'use=!keep(guardBox,inject);}}if(use){'+oracleTail+'}';
  const oracle='int x=seed;long y=seed;'+protect((nested?'if(outer(outerBox)){'+select+'}':select)+'event(3);')+'return snap(x,y);';
  for(const[name,body]of [['old',source],['next',next.source],['clean',clean.source],['oracle',oracle]])methods+=`static String ${name}${models}(Boolean outerBox,Boolean conditionBox,Boolean earlyBox,Boolean guardBox,Boolean postBox,int seed,int inject,int mode){${body}}\n`;models++;
 }
 const java=`public class ConditionalNative{static volatile int counter;static int effects;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){effects=effects*31+n;trace.append((char)('a'+n));}static boolean outer(Boolean b){event(10);return b.booleanValue();}static boolean probe(Boolean b){event(0);return b.booleanValue();}static boolean early(Boolean b){event(5);return b.booleanValue();}static boolean keep(Boolean b,int inject){event(2);if(inject==2)throw FAILURE;return b.booleanValue();}static Boolean post(Boolean b,int inject){event(4);counter=counter+1;if(inject==3)throw FAILURE;return b;}static String snap(int x,long y){return x+":"+y+":"+effects+":"+counter+":"+trace;}
${methods}
static String take(int kind,int variant,Boolean outerBox,Boolean conditionBox,Boolean earlyBox,Boolean guardBox,Boolean postBox,int seed,int inject,int mode,boolean nullLock){effects=seed;counter=seed;trace=new StringBuilder();lock=nullLock?null:new Object();String result;try{switch(kind){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(outerBox,conditionBox,earlyBox,guardBox,postBox,seed,inject,mode):variant==1?next${i}(outerBox,conditionBox,earlyBox,guardBox,postBox,seed,inject,mode):variant==2?clean${i}(outerBox,conditionBox,earlyBox,guardBox,postBox,seed,inject,mode):oracle${i}(outerBox,conditionBox,earlyBox,guardBox,postBox,seed,inject,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable error){result=error==FAILURE?"failure":error==OVERRIDE?"override":error.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+effects+":"+counter+":"+trace;}
public static void main(String[]args){int cases=0;for(int kind=0;kind<${models};kind++)for(Boolean outerBox:new Boolean[]{false,true,null})for(Boolean conditionBox:new Boolean[]{false,true,null})for(Boolean earlyBox:new Boolean[]{false,true,null})for(Boolean guardBox:new Boolean[]{false,true,null})for(Boolean postBox:new Boolean[]{false,true,null})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int inject=0;inject<4;inject++)for(int mode=0;mode<3;mode++)for(boolean nullLock:new boolean[]{false,true}){String expected=take(kind,3,outerBox,conditionBox,earlyBox,guardBox,postBox,seed,inject,mode,nullLock);for(int variant=0;variant<3;variant++)if(!take(kind,variant,outerBox,conditionBox,earlyBox,guardBox,postBox,seed,inject,mode,nullLock).equals(expected))throw new AssertionError(kind+":"+variant+":"+seed);cases++;}System.out.println(cases+" cases, ${models} models");}}
`;fs.writeFileSync(path.join(directory,'ConditionalNative.java'),java);run('javac',['-d',directory,path.join(directory,'ConditionalNative.java')]);assert.equal(run('java',['-Xmx128m','-cp',directory,'ConditionalNative']),'1049760 cases, 36 models');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
