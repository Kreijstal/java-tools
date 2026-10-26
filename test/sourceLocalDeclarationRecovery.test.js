'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const {localizeCompilationUnitDeclarations:recover,localizeBodyDeclarations}=require('../src/decompiler/javaAstEmitter');

const unchanged=source=>({source,bodiesLocalized:0,declarationsMoved:0,declarationsMerged:0,inertStoresRemoved:0});

test('uses the default body proofs independently in overloaded methods',()=>{
 const source='class A{void f(int p){int value;value=p;use(value);}void f(Object p){Object value=null;value=p;use(value);}void loop(){int i;for(i=0;i<3;i++){use(i);}}}';
 const result=recover(source);assert.deepEqual(result,{source:'class A{void f(int p){int value=p;use(value);}void f(Object p){Object value=p;use(value);}void loop(){for(int i=0;i<3;i++){use(i);}}}',bodiesLocalized:3,declarationsMoved:1,declarationsMerged:2,inertStoresRemoved:0});
 assert.deepEqual(recover(result.source),unchanged(result.source));
 assert.deepEqual(localizeBodyDeclarations('int i;int x;x=first();for(i=0;i<3;i++){use(i,x);}'),{source:'int x=first();for(int i=0;i<3;i++){use(i,x);}',declarationsMoved:1,declarationsMerged:1,inertStoresRemoved:0});
});

test('resolves an inert prelude before a for-header lifetime in one default pass',()=>{
 const source='class A{void f(){int value;value=0;for(value=0;value<3;value++){use(value);}}}';
 const result=recover(source);assert.deepEqual(result,{source:'class A{void f(){for(int value=0;value<3;value++){use(value);}}}',bodiesLocalized:1,declarationsMoved:1,declarationsMerged:1,inertStoresRemoved:0});
 assert.deepEqual(recover(result.source),unchanged(result.source));
});

test('preserves headers, comments, fields and literal bytes outside edited bodies',()=>{
 const source='/* license { ; } */\npackage example;\nimport java.util.*;\n@SuppressWarnings("unchecked") class A<T> {\n String s="{void f(){}}";\n @Deprecated <E extends Number> List<E> f(E p) throws Exception {\n  List<E> result;\n  result = new ArrayList<E>();\n  return result;\n }\n}';
 const expected=source.replace('  List<E> result;\n','').replace('result = new','List<E> result = new');
 assert.deepEqual(recover(source),{source:expected,bodiesLocalized:1,declarationsMoved:0,declarationsMerged:1,inertStoresRemoved:0});
});

test('handles constructors, initializer blocks, member types, enum methods and interface defaults',()=>{
 const source='class A{A(){this(1);int a;a=next();use(a);}A(int p){}static{int b;b=next();use(b);}{int c;c=next();use(c);}class B{void f(){int d;d=next();use(d);}}}enum E{ONE;int f(){int e;e=1;return e;}}interface I{default int f(){int f;f=2;return f;}void untouched();}';
 const result=recover(source);assert.equal(result.bodiesLocalized,6);assert.equal(result.declarationsMerged,6);
 assert.match(result.source,/A\(\)\{this\(1\);int a=next\(\);/);assert.match(result.source,/static\{int b=next\(\);/);assert.match(result.source,/class B\{void f\(\)\{int d=next\(\);/);assert.match(result.source,/ONE;int f\(\)\{int e=1;/);assert.match(result.source,/void untouched\(\);/);
});

for(const[name,source]of[
 ['unicode translation','class A{void f(){int val\\u0075e;value=next();use(value);}}'],
 ['unbalanced file','class A{void f(){int value;value=next();use(value);}'],
 ['malformed body','class A{void f(){int value;value=;use(value);}}'],
 ['lambda','class A{void f(){int value;value=next();run(()->use(value));}}'],
 ['local class','class A{void f(){int value;value=next();class B{void g(){int inner;inner=next();use(inner);}}use(value);}}'],
 ['anonymous class','class A{void f(){int value;value=next();run(new Runnable(){public void run(){int inner;inner=next();use(inner);}});use(value);}}'],
 ['anonymous field','class A{Object r=new Runnable(){public void run(){int inner;inner=next();use(inner);}};}'],
 ['comment inside method','class A{void f(){int value;/* retain */value=next();use(value);}}'],
 ['capture of default in finally','class A{void f(){int value=1;try{value=next();}finally{use(value);}}}'],
 ['abstract and native members','abstract class A{abstract void a();native int b();}'],
])test(`leaves ${name} intact`,()=>assert.deepEqual(recover(source),unchanged(source)));

test('an unsupported body does not prevent independent supported method recovery',()=>{
 const source='class A{void f(){try(Resource r=open()){work();}}void g(){int value;value=next();use(value);}}';
 const result=recover(source);assert.equal(result.bodiesLocalized,1);assert.equal(result.source,source.replace('int value;value=','int value='));
});

test('assembles a large method set once and is deterministic',()=>{
 const source='class A{'+Array.from({length:1000},(_,i)=>`int m${i}(int p){int value;value=p;return value;}`).join('\n')+'}';
 const result=recover(source);assert.equal(result.bodiesLocalized,1000);assert.equal(result.declarationsMerged,1000);assert.deepEqual(recover(result.source),unchanged(result.source));
});

function run(command,args,cwd){const r=spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(r.status,0,r.stderr||r.error?.stack||r.stdout);return r.stdout.trim();}

test('a complete native source roundtrip preserves fields, overloads, initialization and protected scopes',()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'source-local-declarations-'));
 try{
  const original=path.join(temporary,'original'),next=path.join(temporary,'next');fs.mkdirSync(original);fs.mkdirSync(next);
  const source=`public class SourceScopeNative{
   static final StringBuilder trace=new StringBuilder();static final Object lock=new Object();static final Integer shared=Integer.valueOf(1234);static int mode;int field;
   static{int initial;initial=7;trace.append(initial);}
   {int value;value=3;field=value;}
   SourceScopeNative(){this(1);int value;value=create(2);field+=value;}
   SourceScopeNative(int p){int value;value=create(p);field+=value;}
   static int create(int value){trace.append('c').append(value).append(Thread.holdsLock(lock));if(mode==1&&value==1)throw new IllegalArgumentException();return value;}
   static String tag(Object value){return "O";}static String tag(Number value){return "N";}static String tag(Integer value){return "I";}
   static Number reference(Integer p){Number value=null;try{value=p;trace.append(tag(value));return value;}finally{trace.append('r');}}
   static int loop(int limit){int i;int sum=0;try{synchronized(lock){for(i=0;i<limit;i++){int value;value=create(i);if(i==0)continue;sum+=value;if(i==3)break;}}}finally{trace.append('f').append(Thread.holdsLock(lock));}return sum;}
   static int observed(){int value=17;value=23;try{value=create(1);return value;}finally{trace.append('v').append(value);}}
   static class Member{static int twice(int p){int value;value=p*2;return value;}}
   public static void main(String[]args){for(mode=0;mode<2;mode++)for(int limit=-1;limit<6;limit++){trace.setLength(0);try{trace.append(observed());}catch(Throwable error){trace.append(error.getClass().getName());}try{SourceScopeNative a=new SourceScopeNative();trace.append(a.field).append(reference(shared)==shared).append(loop(limit)).append(Member.twice(limit));}catch(Throwable error){trace.append(error.getClass().getName());}System.out.println(mode+":"+limit+":"+trace);}}
  }`;
  const result=recover(source);assert.ok(result.bodiesLocalized>=7);assert.equal(result.declarationsMoved,1);assert.match(result.source,/Number value=p/);assert.match(result.source,/int value=23;try\{value=create\(1\);/);
  for(const[dir,text]of[[original,source],[next,result.source]]){fs.writeFileSync(path.join(dir,'SourceScopeNative.java'),text);run('javac',['--release','8','SourceScopeNative.java'],dir);}
  const expected=run('java',['-Xverify:all','-cp',original,'SourceScopeNative'],original);assert.equal(expected.split('\n').length,14);assert.match(expected,/1:-1:c1falsev23java\.lang\.IllegalArgumentException/);assert.equal(run('java',['-Xverify:all','-cp',next,'SourceScopeNative'],next),expected);
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
