'use strict';
const test=require('tape');
const fs=require('fs'),os=require('os'),path=require('path');
const {JVM}=require('../src/core/jvm');
const frontend=require('../src/java-frontend');

test('real worker recovers an undersized grant and executes the transported body',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'worker-grant-recovery-'));
 t.teardown(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const fields=Array.from({length:100},(_,i)=>'v'+i);
 const source=path.join(dir,'GrantRecovery.java');
 fs.writeFileSync(source,`public class GrantRecovery {
 ${fields.map((v,i)=>`static int ${v}=${i+1};`).join('\n')}
 static int sum(){return ${fields.join('+')};}
 public static void main(String[] args){System.out.println(sum());}
 }`);
 frontend.compileJavaFile(source,{outputDir:dir,sourceFileName:'GrantRecovery.java'});
 const j=new JVM({classpath:dir,prepareBeforeMain:false,jit:{compileWorker:true,compileWorkerGrantStride:64,warmupThreshold:0}});
 t.teardown(()=>j.jit.compileWorker.dispose());
 const out=[];
 j.registerJreMethods({'java/io/PrintStream':{'println(I)V':(_j,_o,args)=>out.push(args[0])}});
 await j.run('GrantRecovery');
 await j.jit.compileWorker.whenIdle();
 const method=j.classes.GrantRecovery.ast.classes[0].items.find(x=>x.method?.name==='sum').method;
 t.ok(j.jit.compileWorker.stats.grantRetried>0,'the actual worker reported overflow and was retried');
 t.ok(j.jit.compileWorker.installedMethods.has(method),'recovered body was installed');
 await j.run('GrantRecovery');
 t.deepEqual(out,[5050,5050],'execution before and after installation agrees');
 t.notOk(j.jit.compileWorker.declined.has(method),'method is not permanently refused');
 t.end();
});
