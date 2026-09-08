'use strict';
const test=require('tape'),fs=require('fs'),os=require('os'),path=require('path');
const {execFileSync}=require('child_process');
const {JVM}=require('../src/core/jvm');
test('bounded final-this integer inlining preserves arithmetic and rejects unsafe calls',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'final-receiver-'));
 t.teardown(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'FinalReceiver.java'),`
 public final class FinalReceiver {
   int leaf(int x) { return x * 3171 + 1234567; }
   int middle(int x) { return leaf(x) ^ leaf(x + 7); }
   int root(int x) { return middle(x) + leaf(x - 13); }
   synchronized int locked(int x) { return x + 1; }
   int monitor(int x) { return locked(x); }
   int recursive(int x) { return recursive(x); }
 }
 class OpenReceiver { int leaf(int x) { return x + 1; } int root(int x) { return leaf(x); } }
 `);
 execFileSync('javac',['--release','8','-d',dir,path.join(dir,'FinalReceiver.java')]);
 const j=new JVM({classpath:dir,jit:{compileWorker:false,inlineFinalReceiverCalls:true}});
 await j.loadClassByName('FinalReceiver');await j.loadClassByName('OpenReceiver');
 const method=(owner,name)=>j.findMethod(j.classes[owner],name,'(I)I');
 const root=method('FinalReceiver','root');
 const before=j.classInitializationState.get('FinalReceiver');
 const raw=j.jit.getDirectInlineIntegerRegion(root,['int'],'int');
 t.equal(typeof raw,'function','same-final-owner call tree publishes a scalar body');
 const receiver={type:'FinalReceiver'};
 const leaf=x=>(Math.imul(x,3171)+1234567)|0;
 for(const x of [0,1,-1,2147483647,-2147483648,98123])
  t.equal(raw(receiver,x),((leaf(x)^leaf((x+7)|0))+leaf((x-13)|0))|0,
   'Java overflow and nested evaluation agree for '+x);
 t.equal(j.classInitializationState.get('FinalReceiver'),before,'planning executes no class initializer');
 for(const [owner,name] of [['FinalReceiver','monitor'],['FinalReceiver','recursive'],['OpenReceiver','root']])
  t.equal(j.jit.getDirectInlineIntegerRegion(method(owner,name),['int'],'int'),null,
   owner+'.'+name+' retains canonical execution');
 const control=new JVM({classpath:dir,jit:{compileWorker:false}});
 await control.loadClassByName('FinalReceiver');
 t.equal(control.jit.getDirectInlineIntegerRegion(
  control.findMethod(control.classes.FinalReceiver,'root','(I)I'),['int'],'int'),null,
  'new admission remains opt-in');
 t.end();
});
