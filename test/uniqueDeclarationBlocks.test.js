'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {flattenStandaloneBlocks:fold}=require('../src/decompiler/javaAstEmitter');
const mode={uniqueDeclarations:true,declarationsOnly:true,retainDiagnostics:true};
test('unique declarations retain their complete initialization and work while empty scopes disappear',()=>{
 const source='{boolean first=true;{boolean second=probe();if(second){first=false;}if(first){work();}}}after();';
 const r=fold(source,mode);assert.equal(r.blocksFlattened,2);assert.equal(r.source,'boolean first=true;boolean second=probe();if(second){first=false;}if(first){work();}after();');
 assert.deepEqual(r.diagnostics.blocks.map(b=>b.declarations),[['first'],['second']]);assert.equal(fold(source).source,source);
 const pair='{int first=read(),second=read();use(first,second);}';assert.equal(fold(pair,mode).source,'int first=read(),second=read();use(first,second);');
 assert.equal(fold('{work();}',mode).blocksFlattened,0);
 assert.equal(fold('{work();}',{...mode,declarationsOnly:false}).blocksFlattened,1);
});
test('outside identifier occurrences, duplicate locals and reserved formal names refuse scope expansion',()=>{
 for(const source of ['{int local=read();use(local);}use(local);','use(local);{int local=read();use(local);}',
  '{int local=1;use(local);}{int local=2;use(local);}','{int local=read();use(local);}other.local=1;',
  '{int local=read();use(local);}local:while(run()){break local;}',
  '{int local=read();use(local);}try{work();}catch(Exception local){work();}',
  '{int local=read();use(local);}for(int local=0;local<2;local++){work();}'])assert.equal(fold(source,mode).source,source);
 assert.equal(fold('{int parameter=read();use(parameter);}',{...mode,reservedNames:['parameter']}).blocksFlattened,0);
 assert.equal(fold('{int x=0;}',{...mode,uniqueDeclarations:1}).blocksFlattened,0);
 assert.equal(fold('{int x=0;}',{...mode,reservedNames:[null]}).blocksFlattened,0);
});
test('protected, labeled, loop and branch bodies survive; captures and unknown source refuse',()=>{
 for(const source of ['if(flag){int local=read();use(local);}','while(run()){int local=read();use(local);}',
  'Label:{int local=read();use(local);}','try{int local=read();use(local);}finally{cleanup();}',
  'synchronized(lock){int local=read();use(local);}'])assert.equal(fold(source,mode).source,source);
 for(const source of ['{int local=read();use(local);}Runnable r=()->work();','{int local=read();use(local);}class Nested{}',
  '{int local=read();use(local);}//comment\n','{int local=read();use(local);}\\u000a'])assert.equal(fold(source,mode).source,source);
 const source='{int local=read();use(local);}read("local");';assert.equal(fold(source,mode).blocksFlattened,1);
});
test('native expanded scopes match independent work oracles through snapshots, aliases and protection',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'unique-declaration-native-'));
 const run=(cmd,args)=>{const files=['out','err'].map(n=>path.join(dir,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(f=>fs.closeSync(f));}};
 const models=[
  ['{boolean selected=probe(boxed);if(selected){work(flag);}}event(4);','if(probe(boxed)){work(flag);}event(4);'],
  ['{boolean first=true;{boolean second=probe(boxed);if(second){first=(flag!=0);event(2);}if(first){work(flag);}}}event(4);','if(probe(boxed)){event(2);if(flag!=0)work(flag);}else work(flag);event(4);'],
  ['Exit:{{int captured=sample();event(2);if(flag==0)break Exit;work(captured);}event(3);}event(4);','int copy=sample();event(2);if(flag!=0){work(copy);event(3);}event(4);'],
  ['try{{final Object alias=lock;int captured=sample();work(captured);if(alias!=lock)throw new AssertionError();}}finally{{boolean overrideReturn=(mode==1);event(3);if(overrideReturn)return snapshot();if(mode==2)throw OVERRIDE;}}event(4);','try{Object copy=lock;int value=sample();work(value);if(copy!=lock)throw new AssertionError();}finally{event(3);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}event(4);'],
  ['synchronized(lock){{int captured=sample();Object alias=lock;event(2);work(captured);if(alias!=lock)throw new AssertionError();}}event(4);','synchronized(lock){int copy=sample();Object copyLock=lock;event(2);work(copy);if(copyLock!=lock)throw new AssertionError();}event(4);'],
  ['for(index=0;index<limit;index++){{int captured=sample();Object alias=lock;if(flag==0)continue;work(captured);if(alias!=lock)throw new AssertionError();}}event(4);','for(index=0;index<limit;index++){int copy=sample();Object copyLock=lock;if(flag!=0){work(copy);if(copyLock!=lock)throw new AssertionError();}}event(4);'],
 ];
 try{let methods='';for(let i=0;i<models.length;i++){const before=models[i][0]+'return snapshot();',r=fold(before,mode);assert.ok(r.blocksFlattened>0,before);for(const[name,body]of[['old',before],['next',r.source],['oracle',models[i][1]+'return snapshot();']])methods+=`static String ${name}${i}(int limit,Boolean boxed,int flag,int mode){${body}}\n`;}
 const java=`public class UniqueDeclarationOracle{static int value,index,count,failAt,arrayIndex;static volatile int field;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){trace.append(n).append(lock!=null&&Thread.holdsLock(lock)?"L":"U");field=field*31+n;if(count++==failAt)throw FAILURE;}static Boolean probe(Boolean b){event(1);return b;}static int sample(){event(1);int captured=field;int[]values={captured};return values[arrayIndex];}static void work(int n){event(2);value+=n;}static String snapshot(){return value+":"+field+":"+index+":"+count+":"+trace;}${methods}
 static String take(int model,int variant,int limit,Boolean boxed,int flag,int mode,boolean nullLock){value=17;field=flag;index=count=0;lock=nullLock?null:new Object();trace=new StringBuilder();String result;try{switch(model){${models.map((_,i)=>`case ${i}:result=variant==0?old${i}(limit,boxed,flag,mode):variant==1?next${i}(limit,boxed,flag,mode):oracle${i}(limit,boxed,flag,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("lock retained");return result+":"+snapshot();}
 public static void main(String[]args){int cases=0;for(int model=0;model<${models.length};model++)for(int limit=-1;limit<=4;limit++)for(Boolean boxed:new Boolean[]{false,true,null})for(int flag:new int[]{Integer.MIN_VALUE,-1,0,1,7,Integer.MAX_VALUE})for(int mode=0;mode<3;mode++)for(failAt=-1;failAt<9;failAt++)for(arrayIndex=-1;arrayIndex<2;arrayIndex++)for(boolean nullLock:new boolean[]{false,true}){String expected=take(model,2,limit,boxed,flag,mode,nullLock);for(int variant=0;variant<2;variant++)if(!take(model,variant,limit,boxed,flag,mode,nullLock).equals(expected))throw new AssertionError(model+":"+variant+":"+flag+":"+failAt);cases++;}System.out.println(cases);}}
 `;fs.writeFileSync(path.join(dir,'UniqueDeclarationOracle.java'),java);run('javac',['--release','8','-d',dir,path.join(dir,'UniqueDeclarationOracle.java')]);assert.equal(run('java',['-Xmx128m','-cp',dir,'UniqueDeclarationOracle']),'116640');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
