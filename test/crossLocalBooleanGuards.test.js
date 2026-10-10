'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {compactLocalBooleanGuards:fold}=require('../src/decompiler/javaAstEmitter');
const mode={crossLocalAssignments:true,retainDiagnostics:true};
const finish=s=>{let count=0;for(;;){const r=fold(s,mode);if(!r.guardsCompacted)return{source:s,count};count++;s=r.source;}};
test('different primitive locals form an ordered assignment chain while keeping every declaration and store',()=>{
 const source='boolean first=true;boolean second=true;if(ready()){first=read();if(first){second=other();if(second){work();}}}';
 const r=finish(source);assert.equal(r.count,2);assert.equal(r.source,'boolean first=true;boolean second=true;if ((ready()) &&\n(first=read()) &&\n(second=other())) {work();}');
 assert.equal(fold(source).guardsCompacted,0);assert.equal(finish(r.source).count,0);
});
test('complete outer predicates, primitive conversion, parentheses and protected deepest work remain',()=>{
 const source='boolean selected=true;if(left()||right()){selected=nullable();if(selected){try{synchronized(lock){work();}}finally{cleanup();}}}';
 const r=fold(source,mode);assert.equal(r.guardsCompacted,1);assert.ok(r.source.includes('(left()||right()) &&\n(selected=nullable())'));assert.ok(r.source.includes('try{synchronized(lock){work();}}finally{cleanup();}'));
});
test('boxed fields formals duplicate locals scope barriers effects and alternate arms refuse',()=>{
 for(const source of ['Boolean selected=true;if(ready()){selected=read();if(selected){work();}}',
 'if(ready()){this.selected=read();if(this.selected){work();}}',
 'boolean selected=true;{boolean selected=true;if(ready()){selected=read();if(selected){work();}}}',
 'boolean selected=true;if(ready()){selected=read();between();if(selected){work();}}',
 'boolean selected=true;if(ready()){selected=read();if(selected){work();}else other();}',
 'boolean selected=true;if(ready()){try{selected=read();}finally{cleanup();}if(selected){work();}}',
 '{boolean selected=true;}if(ready()){selected=read();if(selected){work();}}'])assert.equal(fold(source,mode).source,source);
 const body='boolean selected=true;if(ready()){selected=read();if(selected){work();}}';
 assert.equal(fold(body,{...mode,reservedNames:['selected']}).guardsCompacted,0);
 assert.equal(fold(body,{...mode,crossLocalAssignments:1}).guardsCompacted,0);
 assert.equal(fold(body+'Runnable r=()->work();',mode).guardsCompacted,0);
});
test('native cross-local assignments match independent branch oracles through mutable flags unboxing and protection',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cross-guard-native-'));
 const run=(command,args)=>{const files=['out','err'].map(n=>path.join(directory,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(command,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const wraps=[s=>s,s=>`try{${s}}finally{event(6);if(mode==1)return snapshot(first,second,third);if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){event(7);${s}}`,s=>`try{${s}}catch(IllegalStateException error){event(8);if(error!=FAILURE)throw error;}finally{event(6);}`];
 const forms=[
  ['probe(a,0)','probe(b,1)','probe(c,2)'],
  ['probe(a,0)||probe(b,3)','probe(b,1)&&(first=!first)','probe(c,2)||(second=!second)'],
  ['probe(a,0)&&(first=!first)','probe(b,1)||(third=!third)','probe(c,2)&&(first==second)'],
 ];
 try{let methods='',models=0;
  for(const [outer,one,two]of forms)for(const wrap of wraps){
   const declarations='boolean first=initialFirst,second=initialSecond,third=initialThird;',before=declarations+wrap(`if(${outer}){first=${one};if(first){second=${two};if(second){event(4);third=!third;}}}event(5);`)+'return snapshot(first,second,third);',next=finish(before);assert.equal(next.count,2,before);
   // Separate primitive decisions avoid using the rewritten conjunction as
   // the oracle, while preserving stores that RHS callbacks may inspect.
   const oracle=declarations+wrap(`boolean enter=${outer};if(enter){boolean oneValue=${one};first=oneValue;if(oneValue){boolean twoValue=${two};second=twoValue;if(twoValue){event(4);third=!third;}}}event(5);`)+'return snapshot(first,second,third);';
   for(const[name,body]of[['old',before],['next',next.source],['oracle',oracle]])methods+=`static String ${name}${models}(Boolean a,Boolean b,Boolean c,boolean initialFirst,boolean initialSecond,boolean initialThird,int mode){${body}}\n`;models++;
  }
  const java=`public class CrossGuardOracle{static int count,failAt;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){trace.append(n).append(lock!=null&&Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}static Boolean probe(Boolean value,int stage){event(stage);return value;}static String snapshot(boolean first,boolean second,boolean third){return first+":"+second+":"+third+":"+count+":"+trace;}${methods}
 static String take(int model,int variant,Boolean a,Boolean b,Boolean c,boolean first,boolean second,boolean third,int mode,boolean nullLock){count=0;lock=nullLock?null:new Object();trace=new StringBuilder();String result;try{switch(model){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(a,b,c,first,second,third,mode):variant==1?next${i}(a,b,c,first,second,third,mode):oracle${i}(a,b,c,first,second,third,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+count+":"+trace;}
 public static void main(String[]args){int cases=0;for(int model=0;model<${models};model++)for(Boolean a:new Boolean[]{false,true,null})for(Boolean b:new Boolean[]{false,true,null})for(Boolean c:new Boolean[]{false,true,null})for(boolean first:new boolean[]{false,true})for(boolean second:new boolean[]{false,true})for(boolean third:new boolean[]{false,true})for(int mode=0;mode<3;mode++)for(failAt=-1;failAt<10;failAt++)for(boolean nullLock:new boolean[]{false,true}){String expected=take(model,2,a,b,c,first,second,third,mode,nullLock);for(int variant=0;variant<2;variant++)if(!take(model,variant,a,b,c,first,second,third,mode,nullLock).equals(expected))throw new AssertionError(model+":"+variant+":"+a+":"+b+":"+c+":"+failAt);cases++;}System.out.println(cases);}}
  `;fs.writeFileSync(path.join(directory,'CrossGuardOracle.java'),java);run('javac',['--release','8','-d',directory,path.join(directory,'CrossGuardOracle.java')]);assert.equal(run('java',['-Xmx128m','-cp',directory,'CrossGuardOracle']),'171072');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
