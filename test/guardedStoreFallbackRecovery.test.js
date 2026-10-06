'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{foldGuardedStoreFallbacks:fold}=require('../src/decompiler/javaAstEmitter');
const{shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;
const frame=(fallback='x=220;y=170;',prefix='prefix();')=>`Frame:{if(outer()){if(choose()){${prefix}if(keep())break Frame;}${fallback}}}`;
const fields={owner:'Game',classQualifierUnshadowed:true,fields:[{name:'flag',type:'boolean',static:false},{name:'counter',type:'int',static:true},{name:'wide',type:'double',static:false},{name:'boxed',type:'Integer',static:false}]};

test('normal emission recovers terminal nested primitive-store fallbacks with one condition/guard occurrence',()=>{
 const source='int x=0;int y=0;'+frame(),body=[source];finish(body);
 assert.equal(body[0],'int x=0;int y=0;if(outer()){if(choose()){prefix();if (!(keep())) {x=220;y=170;}} else {x=220;y=170;}}');assert.equal(fold(body[0]).framesRecovered,0);
});
test('direct and else-arm corridors preserve fields, prefixes and declaration scopes',()=>{
 for(const source of['Frame:{before();if(choose()){prefix();if(keep())break Frame;}this.flag=false;}',
  'Frame:{if(outer()){other();}else{if(choose()){prefix();if(keep())break Frame;}Game.counter=-2147483648;}}',
  'Frame:{int x=0;int y=0;if(outer()){if(choose()){prefix();if(keep())break Frame;}x=220;y=170;}}',
  'if(outer())Frame:{if(choose()){prefix();if(keep())break Frame;}this.flag=false;}else other();']){
   const next=fold(source,{ownedFields:fields,retainDiagnostics:true});assert.equal(next.framesRecovered,1,source);assert.equal(fold(next.source,{ownedFields:fields}).framesRecovered,0);assert.equal(next.source.split('choose()').length-1,1);assert.equal(next.source.split('keep()').length-1,1);
 }
});
test('computed, floating, boxing, uncertain receiver and shadowed type operands refuse',()=>{
 for(const fallback of['this.wide=2.0;','this.boxed=220;','other.flag=false;','x=x+1;','x=(int)wide;','x=read();','x=values[i];','x=++y;']){const source='int x=0;int y=0;'+frame(fallback);assert.equal(fold(source,{ownedFields:fields}).source,source);}
 assert.equal(fold('Frame:{if(choose()){prefix();if(keep())break Frame;}this.flag=false;}',{ownedFields:{...fields,owner:'pkg.Game'}}).framesRecovered,1);
 const qualified='Frame:{if(choose()){prefix();if(keep())break Frame;}Game.counter=220;}';
 assert.equal(fold(qualified,{ownedFields:{...fields,classQualifierUnshadowed:false}}).source,qualified);
 assert.equal(fold('Object Game=null;'+qualified,{ownedFields:fields}).framesRecovered,0);
 assert.equal(fold('Frame:{if(choose()){int x=1;if(keep())break Frame;}counter=220;}',{ownedFields:fields}).framesRecovered,0);
});
test('suffix work, execution/protected corridors, extra exits and budgets refuse',()=>{
 for(const source of['int x=0;int y=0;'+frame().replace(/}}$/, '}after();}'),
  'int x=0;Frame:{while(run()){if(choose()){prefix();if(keep())break Frame;}x=220;}}',
  'int x=0;Frame:{try{if(choose()){prefix();if(keep())break Frame;}x=220;}finally{cleanup();}}',
  'int x=0;Frame:{if(choose()){prefix();if(early())break Frame;if(keep())break Frame;}x=220;}',
  'int x=0;int y=0;'+frame('x=220;'.repeat(9)),
  'int x=0;int y=0;'+frame()+' // comment\n',
  'int x=0;int y=0;'+frame()+'\\u000a',
  'int x=0;int y=0;'+frame()+'Runnable r=()->run();',
  'int x=0;int y=0;'+frame()+' '.repeat(400001)])assert.equal(fold(source).source,source,source.slice(0,100));
});
test('diagnostics identify exactly one store clone and preserve multiline layout',()=>{
 const source='int x=0;int y=0;\nFrame: {\n  if(outer()) {\n    if(choose()) {\n      prefix();\n      if(keep()) break Frame;\n    }\n    x=220;\n    y=170;\n  }\n}',next=fold(source,{retainDiagnostics:true});assert.equal(next.framesRecovered,1);assert.equal(next.fallbackAssignmentsCopied,2);assert.equal(next.fallbackIdentifierCopiesAdded,2);
 const copies=next.diagnostics.segments.filter(s=>s.copy);assert.equal(copies.length,1);assert.equal(source.slice(copies[0].range.start,copies[0].range.end),'x=220;\n    y=170;');assert.deepEqual(next.diagnostics.corridorKinds,['IfStatement','BlockStatement']);assert.equal(fold(next.source).framesRecovered,0);
 assert.ok(next.source.includes('      x=220;\n      y=170;'));assert.ok(!Object.hasOwn(fold(source),'diagnostics'));
});
test('native primitive-store fallbacks preserve nullable guards, volatile write order, partial failures and finally priority',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'guarded-store-native-'));
 const run=(command,args)=>{const files=['out','err'].map(n=>path.join(directory,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(command,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const contexts=[s=>s,s=>`try{${s}}finally{event(7);if(mode==1)return snapshot(x,y);if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){event(6);${s}}`,s=>`try{${s}}catch(IllegalStateException error){event(8);if(error!=FAILURE)throw error;}finally{event(7);}`,s=>`try{synchronized(lock){event(6);${s}}}finally{event(7);if(mode==1)return snapshot(x,y);if(mode==2)throw OVERRIDE;}`,s=>`{Object alias=lock;${s}if(alias!=lock)throw new AssertionError();}`];
 const prefix='event(1);x=x+seed;y=y-1;conditionField=!conditionField;if(inject==1)throw FAILURE;';
 const fallbacks=['x=220;y=-2147483648;','thisFlag=false;x=seed;y=220;'];
 try{
  let methods='',models=0;for(const protect of contexts)for(const nested of [false,true])for(const fallback of fallbacks){
   const active=`if(probe(conditionBox)){${prefix}if(keep(guardBox,inject))break Frame;}${fallback}`,original='int x=seed;int y=seed;'+protect('Frame:{'+(nested?'if(outer(outerBox)){'+active+'}':active)+'}event(3);if(inject==3)throw FAILURE;')+'return snapshot(x,y);',next=fold(original,{parameters:[{name:'seed',type:'int'}],ownedFields:{owner:'GuardedStoreNative',fields:[{name:'thisFlag',type:'boolean',static:true}]}});assert.equal(next.framesRecovered,1,original);
   const selected=`boolean selected=probe(conditionBox);boolean use=true;if(selected){${prefix}use=!keep(guardBox,inject);}if(use){${fallback}}`,oracle='int x=seed;int y=seed;'+protect((nested?'if(outer(outerBox)){'+selected+'}':selected)+'event(3);if(inject==3)throw FAILURE;')+'return snapshot(x,y);';
   for(const[name,body]of[['old',original],['next',next.source],['oracle',oracle]])methods+=`static String ${name}${models}(Boolean outerBox,Boolean conditionBox,Boolean guardBox,int seed,int inject,int mode){${body}}\n`;models++;
  }
  const java=`public class GuardedStoreNative{static boolean conditionField;static volatile boolean thisFlag;static int effects;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){effects=effects*31+n;trace.append((char)('a'+n));}static boolean outer(Boolean b){event(9);return b.booleanValue();}static boolean probe(Boolean b){event(0);conditionField=b.booleanValue();return conditionField;}static boolean keep(Boolean b,int inject){event(2);if(inject==2)throw FAILURE;return b.booleanValue();}static String snapshot(int x,int y){return x+":"+y+":"+effects+":"+conditionField+":"+thisFlag+":"+trace;}
${methods}
static String take(int kind,int variant,Boolean outerBox,Boolean conditionBox,Boolean guardBox,int seed,int inject,int mode,boolean nullLock){effects=seed;trace=new StringBuilder();lock=nullLock?null:new Object();conditionField=false;thisFlag=true;String result;try{switch(kind){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(outerBox,conditionBox,guardBox,seed,inject,mode):variant==1?next${i}(outerBox,conditionBox,guardBox,seed,inject,mode):oracle${i}(outerBox,conditionBox,guardBox,seed,inject,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable error){result=error==FAILURE?"failure":error==OVERRIDE?"override":error.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+effects+":"+thisFlag+":"+trace;}
public static void main(String[]args){int cases=0;for(int kind=0;kind<${models};kind++)for(Boolean outerBox:new Boolean[]{false,true,null})for(Boolean conditionBox:new Boolean[]{false,true,null})for(Boolean guardBox:new Boolean[]{false,true,null})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int inject=0;inject<4;inject++)for(int mode=0;mode<3;mode++)for(boolean nullLock:new boolean[]{false,true}){String want=take(kind,2,outerBox,conditionBox,guardBox,seed,inject,mode,nullLock);for(int variant=0;variant<2;variant++){String got=take(kind,variant,outerBox,conditionBox,guardBox,seed,inject,mode,nullLock);if(!want.equals(got))throw new AssertionError(kind+":"+variant+":"+outerBox+":"+conditionBox+":"+guardBox+":"+seed+":"+inject+":"+mode+":"+want+":"+got);}cases++;}System.out.println(cases+" cases / ${models} models");}}
`;
  const file=path.join(directory,'GuardedStoreNative.java');fs.writeFileSync(file,java);run('javac',['--release','8','-d',directory,file]);assert.equal(run('java',['-Xmx128m','-cp',directory,'GuardedStoreNative']),'77760 cases / 24 models');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
