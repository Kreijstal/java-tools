'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{flattenStandaloneBlocks:flatten}=require('../src/decompiler/javaAstEmitter');

test('standalone block statements flatten while branch, loop, label and protected bodies remain',()=>{
 const source='{first();{second();}}if(flag){{third();}}Label:{{fourth();}}try{{fifth();}}finally{{sixth();}}';
 const r=flatten(source,{retainDiagnostics:true});assert.equal(r.blocksFlattened,6);
 assert.equal(r.source,'first();second();if(flag){third();}Label:{fourth();}try{fifth();}finally{sixth();}');
 assert.equal(flatten(r.source).blocksFlattened,0);
 let expected=source;for(const e of r.diagnostics.deletedRanges.slice().reverse())expected=expected.slice(0,e.start)+expected.slice(e.end);assert.equal(expected,r.source);
});
test('direct declarations and nested declaration scopes survive with original shadowing and bindings',()=>{
 for(const source of['{int local=read();use(local);}later();','{int first=1,second=2;use(first,second);}','{final String name=read();use(name);}'])assert.equal(flatten(source).source,source);
 const source='{if(flag){int local=read();use(local);}{int local=other();use(local);}}';
 assert.equal(flatten(source).source,'if(flag){int local=read();use(local);}{int local=other();use(local);}');
 const scoped='{for(int local=0;local<3;local++){use(local);}}';assert.equal(flatten(scoped).source,'for(int local=0;local<3;local++){use(local);}');
});
test('multiline nesting removes vacant brace lines and dedents each retained line once per block',()=>{
 const source='start();\n{\n  first();\n  {\n    second();\n  }\n  third();\n}\nend();\n';
 assert.equal(flatten(source).source,'start();\nfirst();\nsecond();\nthird();\nend();\n');
 assert.equal(flatten('{}').source,'');assert.equal(flatten('first(); {} second();').source,'first();  second();');
});
test('uncertain scopes, captures, comments, Unicode and invalid contracts refuse',()=>{
 for(const source of['{work();} // comment\n','{work();}\\u000a','{work();}Runnable r=()->work();','{work();}class Inner{void go(){work();}}','{work();}Object x=new Object(){void go(){work();}}','{work();}if(','{work();}'+' '.repeat(400001)])assert.equal(flatten(source).source,source);
 assert.equal(flatten('{work();}',{retainDiagnostics:1}).blocksFlattened,0);
 assert.equal(flatten('{read("//");}').source,'read("//");');
});
test('native flattened blocks match independent action models with scopes, cleanup and monitors',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'standalone-block-native-'));
 const run=(cmd,args)=>{const output=path.join(dir,'out'),error=path.join(dir,'err'),fds=[output,error].map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(error,'utf8'));return fs.readFileSync(output,'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const models=[
  ['{event(1);{value+=flag;event(2);}event(3);}event(4);','event(1);value+=flag;event(2);event(3);event(4);'],
  ['for(index=0;index<limit;index++){{if(boxed){event(1);value+=index;}event(2);}}event(3);','for(index=0;index<limit;index++){if(boxed){event(1);value+=index;}event(2);}event(3);'],
  ['Exit:{{event(1);if(flag==0)break Exit;event(2);}event(3);}event(4);','event(1);if(flag!=0){event(2);event(3);}event(4);'],
  ['try{{event(1);if(boxed){value+=flag;}event(2);}}finally{{event(3);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}}event(4);','try{event(1);if(boxed){value+=flag;}event(2);}finally{event(3);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}event(4);'],
  ['synchronized(lock){{event(1);value+=flag;event(2);}}event(3);','synchronized(lock){event(1);value+=flag;event(2);}event(3);'],
  ['{if(boxed){int scoped=flag;{event(1);value+=scoped;}}{int scoped=limit;event(2);value+=scoped;}}event(3);','if(boxed){int scoped=flag;event(1);value+=scoped;}{int scoped=limit;event(2);value+=scoped;}event(3);'],
 ];
 try{let methods='';for(let i=0;i<models.length;i++){const source=models[i][0]+'return snapshot();',r=flatten(source);assert.ok(r.blocksFlattened>0,source);for(const[name,body]of[['old',source],['next',r.source],['oracle',models[i][1]+'return snapshot();']])methods+=`static String ${name}${i}(int limit,Boolean boxed,int flag,int mode){${body}}\n`;}
 const java=`public class StandaloneBlocks{static int value,index,count,failAt;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){trace.append(n).append(lock!=null&&Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}static String snapshot(){return value+":"+index+":"+count+":"+trace;}${methods}
 static String take(int kind,int variant,int limit,Boolean boxed,int flag,int mode,boolean nullLock){value=17;index=count=0;lock=nullLock?null:new Object();trace=new StringBuilder();String result;try{switch(kind){${models.map((_,i)=>`case ${i}:result=variant==0?old${i}(limit,boxed,flag,mode):variant==1?next${i}(limit,boxed,flag,mode):oracle${i}(limit,boxed,flag,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor retained");return result+":"+snapshot();}
 public static void main(String[]args){int cases=0;for(int kind=0;kind<${models.length};kind++)for(int limit=-1;limit<=4;limit++)for(Boolean boxed:new Boolean[]{false,true,null})for(int flag:new int[]{Integer.MIN_VALUE,-1,0,1,7,Integer.MAX_VALUE})for(int mode=0;mode<3;mode++)for(int failure=-1;failure<9;failure++)for(boolean nullLock:new boolean[]{false,true}){failAt=failure;String expected=take(kind,2,limit,boxed,flag,mode,nullLock);for(int variant=0;variant<2;variant++)if(!expected.equals(take(kind,variant,limit,boxed,flag,mode,nullLock)))throw new AssertionError(kind+":"+variant+":"+expected);cases++;}System.out.println(cases);}}
 `;fs.writeFileSync(path.join(dir,'StandaloneBlocks.java'),java);run('javac',['--release','8','-d',dir,path.join(dir,'StandaloneBlocks.java')]);assert.equal(run('java',['-Xmx128m','-cp',dir,'StandaloneBlocks']),'38880');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
