'use strict';
const test=require('tape'), fs=require('fs'), os=require('os'), path=require('path');
const {execFileSync}=require('child_process');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame'), Stack=require('../src/core/stack');

test('structured positional optimization preserves early labeled exits',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'structured-label-exit-'));
 t.teardown(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'LabelExit.java'),`
 public class LabelExit {
  public static int run(int[] output,int start,int end,int stop) {
   int value=1;
   if(end>64)end=64;
   outer: {
    if(start<0) { if(end<0) {start=end;break outer;} else start=0; }
    while(true) {
     if(start>=end) break outer;
     else {if(start==stop) value=value^7;
      value=value*31+start; output[start]=value; start++;}
    }
   }
   while(start<end+2) {value=value*7+start;start++;}
   return value;
  }
 }
 `);
 execFileSync(process.execPath,[path.resolve(__dirname,'../scripts/compileJava.js'),path.join(dir,'LabelExit.java'),'--out',dir]);
 const j=new JVM({classpath:dir,jit:{compileWorker:false,rendererPipeline:true,structuredSsa:true,profileMethods:false}});
 await j.loadClassByName('LabelExit');
 const method=j.findMethod(j.classes.LabelExit,'run','([IIII)I');
 const generated=j.jit.structuredSsa.compile(method);
 t.ok(generated,'structured compilation succeeds: '+j.jit.structuredSsa.lastRejectionReason);
 if(!generated){t.end();return;}
 const restored=j.jit.materializeGeneratedResult(j.jit.serializeGeneratedResult(generated),method);
 t.ok(restored,'compiled body transports');
 const expected=(start,end,stop)=>{let value=1;const skip=start<0&&end<0;if(start<0)start=end<0?end:0;if(!skip)while(start<end){if(start===stop)value^=7;value=(Math.imul(value,31)+start)|0;start++;}while(start<end+2){value=(Math.imul(value,7)+start)|0;start++;}return value;};
 for(const body of [generated,restored])for(const args of [[-9,-2,20],[-3,7,4],[0,7,4],[0,7,20],[8,7,20],[0,30,40]]){
  const frame=new Frame(method);frame.locals.splice(0,4,new Int32Array(64),...args);
  const thread={status:'runnable',callStack:new Stack()};thread.callStack.push(frame);
  const result=body(frame,thread,j.jit,false);
  t.equal(result.value,expected(...args),'early/normal exit '+args);
 }
 t.end();
});
