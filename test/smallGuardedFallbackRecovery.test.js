'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{foldSmallGuardedFallbacks:fold}=require('../src/decompiler/javaAstEmitter');
const{shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;
const frame=(condition='probe()',prefix='prefix();',guard='keep()',fallback='fallback(2);')=>`Frame:{if(${condition}){${prefix}if(${guard})break Frame;}${fallback}}`;

test('normal emission places a small fallback in exclusive arms without copying condition or guard',()=>{
 const source=frame(),body=[source];finish(body);assert.equal(body.join('\n'),'if(probe()){prefix();if (!(keep())) {fallback(2);}} else {fallback(2);}');
 assert.equal(body[0].split('probe()').length-1,1);assert.equal(body[0].split('keep()').length-1,1);assert.equal(fold(body[0]).framesRecovered,0);
});

test('effectful conditions and guard calls remain at their original points',()=>{
 const source=frame('boxed','changeCondition();','guardBox','this.fallback(payload);'),next=fold(source,{retainDiagnostics:true});assert.equal(next.framesRecovered,1);assert.equal(next.fallbackCallSitesAdded,1);assert.equal(next.fallbackIdentifierCopiesAdded,2);
 const copy=next.diagnostics.segments.filter(s=>s.copy);assert.equal(copy.length,1);assert.equal(source.slice(copy[0].range.start,copy[0].range.end),'this.fallback(payload);');
 assert.ok(next.source.includes('changeCondition();if (!(guardBox))'));assert.ok(!Object.hasOwn(fold(source),'diagnostics'));
});

test('outer declaration scopes and scalar statement slots retain braces',()=>{
 for(const source of['Frame:{Object payload=read();if(probe()){prefix();if(keep())break Frame;}fallback(payload);}',
  'if(outer())'+frame()+'else tail();','while(run()){try{synchronized(lock){'+frame()+'}}finally{cleanup();}}']){const next=fold(source,{retainDiagnostics:true});assert.equal(next.framesRecovered,1);assert.equal(fold(next.source).framesRecovered,0);}
 assert.ok(fold('if(outer())'+frame()+'else tail();').source.includes('else {fallback(2);}}else tail();'));
});

test('shadowing declarations, extra exits and protected jump boundaries refuse',()=>{
 for(const source of[frame('probe()','Object payload=read();','keep()','fallback(payload);'),
  frame('probe()','prefix();if(early())break Frame;'),frame().replace('if(keep())break Frame;','try{if(keep())break Frame;}finally{cleanup();}'),
  frame().replace('fallback(2);','fallback(2);after();'),frame().replace('prefix();',''),
  frame().replace('fallback(2);','if(other())fallback(2);'),frame().replace('fallback(2);','value=2;')])assert.equal(fold(source).source,source);
});

test('only small calls with simple operands are copied, retaining casts, arithmetic and poly expressions',()=>{
 for(const fallback of['fallback(value+1);','fallback((byte)2);','fallback(-2.0f);','fallback(values[index]);','fallback(get());','get().fallback();','fallback(()->run());','fallback(new Thing());','owner.<Thing>fallback(value);',
  'fallback("'+ 'x'.repeat(513) +'");']){const source=frame('probe()','prefix();','keep()',fallback);assert.equal(fold(source).source,source,fallback.slice(0,70));}
 for(const fallback of['owner.fallback(payload);','Parent.fallback(null);','this.owner.fallback(this.payload);','fallback(2.0f);','fallback(-97);','fallback(-2147483648);','fallback(-9007199254740993L);'])assert.equal(fold(frame('probe()','prefix();','keep()',fallback)).framesRecovered,1);
});

test('translated offsets, nested execution, comments and work budgets refuse',()=>{
 for(const source of[frame()+' //comment\n',frame()+'\\u000a',frame()+'Object o=new Object(){};',frame()+'Runnable r=()->run();',frame()+' '.repeat(400001)])assert.equal(fold(source).source,source);
 assert.equal(fold(frame(),{retainDiagnostics:1}).framesRecovered,0);
});

test('native exclusive fallbacks preserve condition mutation, failures, overloads, aliasing and finally priority',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'small-fallback-native-'));
 const run=(command,args)=>{const files=['out','err'].map(n=>path.join(directory,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const result=spawnSync(command,args,{stdio:['ignore',...fds]});if(result.error)throw result.error;assert.equal(result.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const contexts=[s=>s,s=>`try{${s}}finally{event(7);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){event(6);${s}}`,s=>`try{${s}}catch(IllegalStateException error){event(8);if(error!=FAILURE)throw error;}finally{event(7);}`,s=>`try{synchronized(lock){event(6);${s}}}finally{event(7);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`{Object alias=handler;${s}if(alias!=originalHandler)throw new AssertionError();}`];
 try{
  let methods='';for(let i=0;i<contexts.length;i++){
   const source=contexts[i](frame('probe(conditionBox)','prefix(seed,inject);','keep(guardBox,inject)','handler.fallback(payload);')+'event(3);if(inject==3)throw FAILURE;')+'return snapshot();';const next=fold(source);assert.equal(next.framesRecovered,1);
   const oracle=contexts[i]('boolean selected=probe(conditionBox);boolean use=true;if(selected){prefix(seed,inject);use=!keep(guardBox,inject);}if(use)handler.fallback(payload);event(3);if(inject==3)throw FAILURE;')+'return snapshot();';
   for(const[name,body]of[['old',source],['next',next.source],['oracle',oracle]])methods+=`static String ${name}${i}(Boolean conditionBox,Boolean guardBox,int seed,int inject,int mode){${body}}\n`;
  }
  const java=`public class SmallFallbackNative{static int value,effects,fallbacks;static boolean conditionField;static StringBuilder trace;static Object lock;static Integer payload;static Handler handler,originalHandler;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();
static void event(int n){effects=effects*31+n;trace.append((char)('a'+n));}static boolean probe(Boolean boxed){event(0);conditionField=boxed.booleanValue();return conditionField;}static void prefix(int seed,int inject){event(1);value=value+seed;conditionField=!conditionField;if(inject==1)throw FAILURE;}static boolean keep(Boolean boxed,int inject){event(2);if(inject==2)throw FAILURE;return boxed.booleanValue();}static String snapshot(){return value+":"+effects+":"+fallbacks+":"+conditionField+":"+trace;}static class Handler{void fallback(Integer number){if(++fallbacks>1)throw new AssertionError("fallback repeated");event(4);value=value+number.intValue();}void fallback(Object wrong){throw new AssertionError("wrong overload");}}
${methods}
static String take(int kind,int variant,Boolean conditionBox,Boolean guardBox,int seed,int inject,int mode,boolean nullLock,boolean nullPayload){value=seed;effects=seed;fallbacks=0;trace=new StringBuilder();conditionField=false;lock=nullLock?null:new Object();payload=nullPayload?null:Integer.valueOf(seed);handler=new Handler();originalHandler=handler;String result;try{switch(kind){${contexts.map((_,i)=>`case ${i}:result=variant==0?old${i}(conditionBox,guardBox,seed,inject,mode):variant==1?next${i}(conditionBox,guardBox,seed,inject,mode):oracle${i}(conditionBox,guardBox,seed,inject,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable error){result=error==FAILURE?"failure":error==OVERRIDE?"override":error.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+snapshot();}
public static void main(String[]args){int cases=0;for(int kind=0;kind<6;kind++)for(Boolean conditionBox:new Boolean[]{false,true,null})for(Boolean guardBox:new Boolean[]{false,true,null})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int inject=0;inject<4;inject++)for(int mode=0;mode<3;mode++)for(boolean nullLock:new boolean[]{false,true})for(boolean nullPayload:new boolean[]{false,true}){String want=take(kind,2,conditionBox,guardBox,seed,inject,mode,nullLock,nullPayload);for(int variant=0;variant<2;variant++){String got=take(kind,variant,conditionBox,guardBox,seed,inject,mode,nullLock,nullPayload);if(!want.equals(got))throw new AssertionError(kind+":"+variant+":"+conditionBox+":"+guardBox+":"+seed+":"+inject+":"+mode+":"+want+":"+got);}cases++;}System.out.println(cases+" cases / 6 contexts");}}
`;
  const file=path.join(directory,'SmallFallbackNative.java');fs.writeFileSync(file,java);run('javac',['--release','8','-d',directory,file]);assert.equal(run('java',['-Xmx128m','-cp',directory,'SmallFallbackNative']),'12960 cases / 6 contexts');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
