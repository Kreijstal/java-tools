'use strict';
const test=require('tape'),fs=require('fs'),os=require('os'),path=require('path');
const frontend=require('../src/java-frontend');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame'),Stack=require('../src/core/stack');
test('prepared integer inline preserves the original class initialization boundary',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prepared-integer-'));
 t.teardown(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'InlineCaller.java');
 fs.writeFileSync(file,`public class InlineCaller {
  public static int run(int[] out,int x) {out[0]=7;try{return ColdInteger.mask(x,255);}catch(RuntimeException e){out[1]=9;return -1;}}
 }
 class ColdInteger {static int initialized=123;static int mask(int a,int b){return a&b;}static synchronized int locked(int a,int b){return a&b;}}
 `);
 frontend.compileJavaFile(file,{outputDir:dir});
 const j=new JVM({classpath:dir,jit:{compileWorker:false,prepareColdIntegerInlines:true,structuredSsa:true,structuredContinuations:false}});
 await j.preloadClasspathClasses();
 const initialValue=j.classes.ColdInteger.staticFields.get('initialized:I');
 const method=j.findMethod(j.classes.InlineCaller,'run','([II)I');
 const instruction={op:'invokestatic',arg:['Method','ColdInteger',['mask','(II)I']]};
 t.ok(j.jit.getCompileTimeIntegerLeaf(instruction,true)?.requiresInitializationGuard,'pure body planned while cold');
 t.equal(j.jit.getCompileTimeIntegerLeaf(instruction,false),null,'unguarded scalar emitter stays conservative');
 t.equal(j.jit.getCompileTimeIntegerLeaf({op:'invokestatic',arg:['Method','ColdInteger',['locked','(II)I']]},true),null,'monitor semantics are not inlined');
 const g=j.jit.structuredSsa.compile(method);
 t.ok(g,'caller compiles before initialization');
 if(!g){t.end();return;}
 const rebound=j.jit.materializeGeneratedResult(j.jit.serializeGeneratedResult(g),method);
 t.ok(rebound,'symbolic initialization guard transports');
 for(const body of [g,rebound]){
  for(const state of [undefined,'INITIALIZING','ERRONEOUS','INITIALIZED']){
   j._setClassInitializationState('ColdInteger',state);
   const out=new Int32Array(2),f=new Frame(method);f.locals[0]=out;f.locals[1]=511;
   const thread={status:'runnable',callStack:new Stack()};thread.callStack.push(f);
   const r=body(f,thread,j.jit,false);
   t.equal(out[0],7,'pre-invoke effect retained: '+state);
   if(state==='INITIALIZED')t.equal(r.value,255,'same prepared body executes inline when ready');
   else{
    t.equal(r.deopt,true,'unready/failed initialization takes canonical path');
    t.deepEqual(f.stack.items,[511,255],'invoke operands survive fallback');
    t.equal(f.instructions[f.pc].instruction.op,'invokestatic','fallback is exactly at invoke');
   }
   t.equal(out[1],0,'guard does not fabricate a guest exception');
  }
 }
 t.equal(j.classes.ColdInteger.staticFields.get('initialized:I'),initialValue,'planning and guards did not execute initializer');
 t.end();
});

test('prepared integer inline executes real initialization after preceding guest effects',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prepared-integer-run-'));
 t.teardown(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'InlineMain.java');
 fs.writeFileSync(file,`public class InlineMain {
  static int events; static int result;
  static int call(int x){events=events*10+1;return InlineTarget.mask(x,255);}
  public static void main(String[] args){result=call(511);result+=call(256);}
 }
 class InlineTarget {static int stamp=initialize();
  static int initialize(){InlineMain.events=InlineMain.events*10+2;return 123;}
  static int mask(int a,int b){return a&b;}
 }
 `);
 frontend.compileJavaFile(file,{outputDir:dir});
 const j=new JVM({classpath:dir,prepareBeforeMain:true,jit:{compileWorker:false,
  prepareColdIntegerInlines:true,structuredSsa:true,structuredContinuations:false}});
 await j.preloadClasspathClasses();
 const method=j.findMethod(j.classes.InlineMain,'call','(I)I');
 const prepared=j.jit.getGeneratedFunction(method,{allowEffectfulCalls:true,compileLocally:true});
 t.ok(prepared?.jvmGeneratedSource?.includes('cold prepared integer inline'),
  'cold guard is present before executing the guest');
 t.notEqual(j.classInitializationState.get('InlineTarget'),'INITIALIZED','preparation leaves target cold');
 await j.run('InlineMain');
 t.equal(j.classes.InlineMain.staticFields.get('events:I'),121,'initializer executes once, between the two caller effects');
 t.equal(j.classes.InlineMain.staticFields.get('result:I'),255,'both calls preserve their results');
 t.equal(j.classes.InlineTarget.staticFields.get('stamp:I'),123,'real initializer completed');
 t.end();
});
