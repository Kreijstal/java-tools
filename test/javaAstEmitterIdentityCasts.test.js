'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const {simplifyIdentityReferenceCasts:fold}=require('../src/decompiler/javaAstEmitter');
function run(command,args,directory){const files=['stdout','stderr'].map(n=>path.join(directory,n)),fds=files.map(f=>fs.openSync(f,'w'));try{
 const result=spawnSync(command,args,{stdio:['ignore',...fds],timeout:15000,env:{...process.env,JAVA_TOOL_OPTIONS:'-XX:-UsePerfData'}});
 if(result.error)throw result.error;assert.equal(result.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8');
}finally{fds.forEach(fd=>fs.closeSync(fd));}}

test('identity reference casts preserve exact local types and token boundaries',()=>{
 for(const [source,expected,count]of [
  ['StringBuilder value=null;sink((StringBuilder)((value)));','StringBuilder value=null;sink(value);',1],
  ['StringBuilder value=null;sink((StringBuilder)((StringBuilder)((value))));','StringBuilder value=null;sink(value);',2],
  ['String value=null;return(String)(value);','String value=null;return value;',1],
  ['String value=null;return(String)(value)instanceof String;','String value=null;return value instanceof String;',1],
  ['java.lang.Object value=null;sink((java.lang.Object)((value)));','java.lang.Object value=null;sink(value);',1],
  ['String[] value=null;sink((String[])value);','String[] value=null;sink(value);',1],
  ['int[][] value=null;sink((int[][])((value)));','int[][] value=null;sink(value);',1],
  ['String value[]=null;sink((String[])value);','String value[]=null;sink(value);',1],
  ['Object value=null;sink((StringBuilder)((Object)(value)));','Object value=null;sink((StringBuilder)(value));',1],
  ['StringBuilder value=null;((StringBuilder)(value)).append("x");','StringBuilder value=null;(value).append("x");',1],
 ]){const next=fold(source);assert.deepEqual(next,{source:expected,castsRemoved:count});assert.equal(fold(next.source).castsRemoved,0);}
});

test('identity casts require a unique declaration in the current lexical block',()=>{
 const source='sink((Child)value);{Child value=null;sink((Child)value);}sink((Child)value);';
 assert.equal(fold(source).source,'sink((Child)value);{Child value=null;sink(value);}sink((Child)value);');
 const protectedSource='try { Child value=null; sink((Child)value); } catch(Exception failure) { Child other=null; sink((Child)other); } finally { Child last=null; sink((Child)last); }';
 assert.equal(fold(protectedSource).castsRemoved,3);
 const ownInitializer='Child value=(Child)value; sink((Child)value);';
 assert.equal(fold(ownInitializer).source,'Child value=(Child)value; sink(value);');
 for(const source of [
  '{Child value=null;sink((Child)value);} {Other value=null;sink((Other)value);}',
  'Child value=null; {Child value=null;sink((Child)value);}',
  'for(Child value:values)sink((Child)value);',
  'try {work();}catch(Exception value){sink((Exception)value);}',
  'for(Child value=null;more();)sink((Child)value);',
  'switch(mode){case 0: Child value=null;sink((Child)value);break;}',
  'sink((Child)value);Child value=null;',
 ])assert.deepEqual(fold(source),{source,castsRemoved:0},source);
});

test('different casts, postfix operands, primitive conversions and unproven syntax remain',()=>{
 for(const source of [
  'Child value=null;sink((Child)((Object)value));',
  'Child value=null;sink((Base)value);',
  'Base value=null;sink((Child)value);',
  'Child value=null;sink((Child)value.base());',
  'Object[] value=null;sink((Object[])value[0]);',
  'Child value=null;sink((Child)get(value));',
  'Child get=null;sink((Child)get());',
  'Child value=null;sink((Child)this.value);',
  'Child value=null;sink((Child)(value=other));',
  'Integer value=0;sink((Integer)value++);',
  'Integer value=0;sink((Integer)value--);',
  'int value=0;sink((int)value);',
  'float value=0f;sink((float)value);',
  'String value=null;sink((java.lang.String)value);',
  'java.lang.String value=null;sink((String)value);',
  'java.util.List<String> value=null;sink((java.util.List)value);',
  '@Mark Child value=null;sink((Child)value);',
  'Child value=null;sink((@Mark Child)value);',
  'Child value=null; // retain comment\n sink((Child)value);',
  'Child value=null;Runnable task=()->sink((Child)value);',
  'Child value=null;class Local {void run(){sink((Child)value);}}',
  'Child value=null;sink((Child)value); unknown syntax here',
  'Child value=null;sink((Child)\\u0076alue);',
 ])assert.deepEqual(fold(source),{source,castsRemoved:0},source);
});

test('cast-type diagnostics identify only removed original type tokens and are optional',()=>{
 const source='Child value=null;sink((Child)((Child)(value)));';
 const next=fold(source,{retainDiagnostics:true});assert.equal(next.castsRemoved,2);assert.equal(next.removedCastTypeRanges.length,2);
 for(const span of next.removedCastTypeRanges){assert.equal(source.slice(span.start,span.end),'Child');assert.equal(span.type,'Child');assert.equal(span.localName,'value');}
 assert.ok(!Object.hasOwn(fold(source),'removedCastTypeRanges'));
 const deep='Child value=null;sink((Child)'+'('.repeat(140)+'value'+')'.repeat(140)+');';
 assert.equal(fold(deep).castsRemoved,0,'bounded proof refuses excessive grouping');
});

test('native identity-cast cleanup preserves overloads, checks, unboxing, scopes, effects and cleanup',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'identity-reference-casts-'));
 try{
  const variants=[
   ['Child value=child(nullRef);sink((Child)(value));',1],
   ['Child value=child(nullRef);sink((Child)((Child)((value))));',2],
   ['Base value=child(nullRef);sink((Base)(value));',1],
   ['java.lang.Object value=child(nullRef);sink((java.lang.Object)((java.lang.Object)(value)));',2],
   ['Object value=child(nullRef);sink((Object)((value)));',1],
   ['String[] value=strings(nullRef);sink((String[])(value));',1],
   ['String[][] value=matrix(nullRef);sink((String[][])value);',1],
   ['int[] value=ints(nullRef);sink((int[])((value)));',1],
   ['String value=nullRef?null:"x";sink((String)(value));',1],
   ['StringBuilder value=builder(nullRef);((StringBuilder)(value)).append("a");sink((StringBuilder)value);',2],
   ['Boolean value=boxed;if((Boolean)(value))trace.append("t");else trace.append("f");',1],
   ['Integer value=2;sink((Integer)value);sink((Integer)value++);sink((Integer)(value));',2],
   ['try{Child value=child(nullRef);sink((Child)value);}finally{cleanup();}',1],
   ['synchronized(lock){Child value=child(nullRef);sink((Child)(value));trace.append(Thread.holdsLock(lock));}',1],
   ['Child value=child(nullRef);Outer:for(int index=0;index<2;index++){try{sink((Child)value);if(index==0)continue Outer;}finally{cleanup();}}',1],
   ['Base value=base(implement,nullRef);sink((Base)value);sink((Base)(Object)value);',1],
   ['java.lang.Object[] value=objects(implement,nullRef);sink((java.lang.Object[])value);sink((java.lang.Object[])value[0]);',1],
   ['Child value=child(nullRef);sink((Child)value);sink((Child)value.base());',1],
   ['Child value=child(nullRef);if((Child)(value)!=null)sink(value);else sink((Child)(value));',2],
   ['Child[] value=children(nullRef);sink((Child[])((value)));',1],
   ['sink((Child)fieldValue);{Child fieldValue=child(nullRef);sink((Child)fieldValue);}sink((Child)fieldValue);',1],
   ['Child[] array=children(nullRef);for(Child item:array)sink((Child)item);Child value=child(nullRef);sink((Child)value);',1],
   ['Child value=child(nullRef);try{sink((Child)value);throw checked;}catch(final java.io.IOException error){sink((java.io.IOException)(error));}',1],
   ['Child[] array=children(nullRef);for(int index=0;index<2;index++){Child value=array[index];sink((Child)value);}',1],
  ];
  const methods=[];variants.forEach(([body,count],index)=>{const next=fold(body);assert.equal(next.castsRemoved,count,index);assert.equal(fold(next.source).castsRemoved,0,index);
   for(const[name,text]of [['original',body],['rebuilt',next.source]])methods.push(`static void ${name}${index}(Boolean boxed,boolean nullRef,boolean implement)throws java.io.IOException{${text}}`);});
  const java=`public class IdentityReferenceCasts {
    interface Object {} static class Base {} static class Plain extends Base {} static class Child extends Base implements Object {Base base(){trace.append("m");return new Plain();}}
    static int mode,effects,cleanups;static StringBuilder trace;static java.lang.Object lock,fieldValue;
    static final RuntimeException specific=new IllegalArgumentException();static final Error fatal=new AssertionError();static final java.io.IOException checked=new java.io.IOException();
    static void prepare(){trace.append("p");effects++;if(mode==1)throw specific;}
    static Child child(boolean absent){prepare();return absent?null:new Child();}
    static Base base(boolean implement,boolean absent){prepare();return absent?null:implement?new Child():new Plain();}
    static String[] strings(boolean absent){prepare();return absent?null:new String[]{"x"};}
    static String[][] matrix(boolean absent){prepare();return absent?null:new String[][]{{"x"}};}
    static int[] ints(boolean absent){prepare();return absent?null:new int[]{1};}
    static Child[] children(boolean absent){prepare();return absent?null:new Child[]{new Child(),new Child()};}
    static java.lang.Object[] objects(boolean implement,boolean absent){prepare();return absent?null:new java.lang.Object[]{implement?new String[]{"x"}:Integer.valueOf(2)};}
    static StringBuilder builder(boolean absent){prepare();return absent?null:new StringBuilder();}
    static void picked(String type){trace.append(type).append(lock!=null&&Thread.holdsLock(lock));effects++;if(mode==2)throw specific;}
    static void sink(Child x){picked("C");}static void sink(Base x){picked("B");}static void sink(Object x){picked("Q");}
    static void sink(String x){picked("T");}static void sink(StringBuilder x){picked("D");}static void sink(String[] x){picked("S");}
    static void sink(String[][] x){picked("M");}static void sink(Child[] x){picked("A");}static void sink(Integer x){picked("I");}
    static void sink(int x){picked("i");}static void sink(java.lang.Object[] x){picked("V");}static void sink(java.lang.Object x){picked("J");}
    static void cleanup(){trace.append("z");cleanups++;if(mode==3)throw fatal;}
    ${methods.join('\n')}
    interface Call{void call()throws java.io.IOException;}
    static String invoke(Call call,boolean nullRef,boolean implement,boolean nullLock){trace=new StringBuilder();effects=0;cleanups=0;lock=nullLock?null:new java.lang.Object();fieldValue=nullRef?null:implement?new Child():new Plain();String result;
      try{call.call();result="ok";}catch(Throwable error){result=error==specific?"specific":error==fatal?"fatal":error==checked?"checked":error.getClass().getName();}
      if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor retained");return result+":"+effects+":"+cleanups+":"+trace;
    }
    public static void main(String[]args){int cases=0;
      if(!invoke(()->rebuilt0(true,false,true),false,true,false).equals("ok:2:0:pCfalse"))throw new AssertionError("Child overload oracle");
      if(!invoke(()->rebuilt2(true,false,true),false,true,false).equals("ok:2:0:pBfalse"))throw new AssertionError("Base overload oracle");
      if(!invoke(()->rebuilt5(true,false,true),false,true,false).equals("ok:2:0:pSfalse"))throw new AssertionError("array overload oracle");
      if(!invoke(()->rebuilt11(true,false,true),false,true,false).equals("ok:3:0:IfalseIfalseIfalse"))throw new AssertionError("postfix boxing oracle");
      if(!invoke(()->rebuilt15(true,false,false),false,false,false).equals("java.lang.ClassCastException:2:0:pBfalse"))throw new AssertionError("custom Object cast oracle");
      if(!invoke(()->rebuilt13(true,false,true),false,true,false).equals("ok:2:0:pCtruetrue"))throw new AssertionError("monitor oracle");
      mode=1;if(!invoke(()->rebuilt12(true,false,true),false,true,false).equals("specific:1:1:pz"))throw new AssertionError("initializer/finally oracle");
      for(mode=0;mode<5;mode++)for(Boolean boxed:new Boolean[]{null,false,true})for(boolean nullRef:new boolean[]{false,true})for(boolean implement:new boolean[]{false,true})for(boolean nullLock:new boolean[]{false,true}){
       ${variants.map((_,index)=>`{String expected=invoke(()->original${index}(boxed,nullRef,implement),nullRef,implement,nullLock),actual=invoke(()->rebuilt${index}(boxed,nullRef,implement),nullRef,implement,nullLock);if(!expected.equals(actual))throw new AssertionError(${index}+":"+mode+":"+boxed+":"+nullRef+":"+implement+":"+nullLock+":"+expected+" != "+actual);cases++;}`).join('\n')}
      }if(cases!=2880)throw new AssertionError(cases);System.out.println("identity-reference-casts-native:"+cases);
    }
  }`;
  const file=path.join(directory,'IdentityReferenceCasts.java');fs.writeFileSync(file,java);run('javac',['--release','8','-d',directory,file],directory);
  assert.equal(run('java',['-cp',directory,'IdentityReferenceCasts'],directory).trim(),'identity-reference-casts-native:2880');
  const javap=run('javap',['-c','-p','-classpath',directory,'IdentityReferenceCasts'],directory).split('\n');
  const bodies=new Map();let current=null;
  for(const line of javap){const match=/^  static void (original|rebuilt)(\d+)\(/.exec(line);if(match){current=match[1]+match[2];bodies.set(current,[]);}else if(/^  \S/.test(line))current=null;else if(current)bodies.get(current).push(line);}
  for(let index=0;index<variants.length;index++)assert.deepEqual(bodies.get('rebuilt'+index),bodies.get('original'+index),'javac instructions/exception tables '+index);
  assert.equal(bodies.size,48);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
