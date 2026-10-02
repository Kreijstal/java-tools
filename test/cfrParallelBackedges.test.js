'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');
const {decompileClassFile, assertNoFallback} = require('../src/decompiler/cfr');

function run(command, args, directory) {
  const paths = ['stdout','stderr'].map(name => path.join(directory,name));
  const fds = paths.map(file => fs.openSync(file,'w'));
  try {
    const result = spawnSync(command,args,{stdio:['ignore',...fds],timeout:15000,
      env:{...process.env,JAVA_TOOL_OPTIONS:'-XX:-UsePerfData'}});
    if(result.error) throw result.error;
    assert.equal(result.status,0,fs.readFileSync(paths[1],'utf8'));
    return fs.readFileSync(paths[0],'utf8');
  } finally {fds.forEach(fd=>fs.closeSync(fd));}
}

const permutations = [
  {name:'SwapBackedge', descriptor:'(III)I', locals:3, stack:3,
    code:`iload_0\n iload_1\n iload_2\n ifle Lreturn
Lloop: swap\n iinc 2 -1\n iload_2\n ifgt Lloop
Lreturn: bipush 100\n imul\n iadd\n ireturn`,
    body:`for(int a:new int[]{-7,0,3,1000}) for(int b:new int[]{-9,0,5})
      for(int count:new int[]{-1,0,1,2,3,4,7})
        System.out.println(SwapBackedge.compute(a,b,count));`, lines:84},
  {name:'ConditionalSwap', descriptor:'(II)I', locals:2, stack:3,
    code:`iload_0\n iload_1
Lloop: swap\n dup\n ifgt Lloop
Lreturn: bipush 100\n imul\n iadd\n ireturn`,
    body:`for(int[] pair:new int[][]{{3,-7},{-7,3},{0,5},{5,0},{-1,-2},{0,0}})
      System.out.println(ConditionalSwap.compute(pair[0],pair[1]));`, lines:6},
  {name:'SwitchSwap', descriptor:'(III)I', locals:3, stack:3,
    code:`iload_0\n iload_1
Lloop: swap\n dup\n lookupswitch
  1 : Lagain
  default : Lreturn
Lagain: iinc 2 -1\n iload_2\n ifgt Lloop
Lreturn: bipush 100\n imul\n iadd\n ireturn`,
    body:`for(int a:new int[]{-7,0,1,3}) for(int b:new int[]{-9,0,1,5})
      for(int count:new int[]{0,1,2,3}) System.out.println(SwitchSwap.compute(a,b,count));`, lines:64},
  {name:'SwitchOnlySwap', descriptor:'(III)I', locals:3, stack:3,
    code:`iload_0\n iload_1
Lloop: swap\n iinc 2 -1\n iload_2\n lookupswitch
  0 : Lreturn
  default : Lloop
Lreturn: bipush 100\n imul\n iadd\n ireturn`,
    body:`for(int a:new int[]{-7,0,1,3}) for(int b:new int[]{-9,0,1,5})
      for(int count:new int[]{1,2,3,4,7}) System.out.println(SwitchOnlySwap.compute(a,b,count));`, lines:80},
  {name:'LongSwap', descriptor:'(JJI)J', locals:5, stack:6,
    code:`lload_0\n lload_2\n iload 4\n ifle Lreturn
Lloop: dup2_x2\n pop2\n iinc 4 -1\n iload 4\n ifgt Lloop
Lreturn: ldc2_w 100L\n lmul\n ladd\n lreturn`,
    body:`for(long a:new long[]{Long.MIN_VALUE,-7,0,Long.MAX_VALUE}) for(long b:new long[]{-9,0,5})
      for(int count:new int[]{-1,0,1,2,3,4,7}) System.out.println(LongSwap.compute(a,b,count));`, lines:84},
  {name:'ReferenceSwap', descriptor:'(Ljava/lang/Object;Ljava/lang/Object;I)Ljava/lang/Object;', locals:3, stack:3,
    code:`aload_0\n aload_1\n iload_2\n ifle Lreturn
Lloop: swap\n iinc 2 -1\n iload_2\n ifgt Lloop
Lreturn: pop\n areturn`,
    body:`Object a=new Object(),b=new Object();for(int count:new int[]{-1,0,1,2,3,4,7}) {
      Object result=ReferenceSwap.compute(a,b,count);System.out.println(result==a?"a":result==b?"b":"other");
    }`, lines:7},
];

for(const fixture of permutations) test(`parallel edge values and consumed selector: ${fixture.name}`,()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-parallel-backedge-'));
  const previous=process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    const native=path.join(temporary,'native');fs.mkdirSync(native);
    const file=path.join(native,fixture.name+'.class');
    assembleJasminSource(`.version 49 0
.class public super ${fixture.name}
.super java/lang/Object
.method public static compute : ${fixture.descriptor}
.code stack ${fixture.stack} locals ${fixture.locals}
 ${fixture.code}
.end code
.end method
.end class`,file);
    const driver=`class Runner {public static void main(String[] args) {${fixture.body}}}`;
    fs.writeFileSync(path.join(native,'Runner.java'),driver);
    run('javac',['--release','8','-cp',native,'-d',native,path.join(native,'Runner.java')],native);
    const expected=run('java',['-cp',native,'Runner'],native);
    assert.equal(expected.trim().split('\n').length,fixture.lines);
    for(const forced of [false,true]) {
      if(forced) process.env.CFR_JS_FORCE_STATE_MACHINE='1';else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
      const source=decompileClassFile(file);assertNoFallback(source);
      assert.equal(source.includes('switch (statePc)'),forced);
      const rebuilt=path.join(temporary,forced?'forced':'structured');fs.mkdirSync(rebuilt);
      fs.writeFileSync(path.join(rebuilt,fixture.name+'.java'),source);
      fs.writeFileSync(path.join(rebuilt,'Runner.java'),driver);
      run('javac',['--release','8','-d',rebuilt,path.join(rebuilt,fixture.name+'.java'),path.join(rebuilt,'Runner.java')],rebuilt);
      assert.equal(run('java',['-cp',rebuilt,'Runner'],rebuilt),expected);
    }
  } finally {
    if(previous===undefined)delete process.env.CFR_JS_FORCE_STATE_MACHINE;else process.env.CFR_JS_FORCE_STATE_MACHINE=previous;
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});

for(const branch of ['ordinary','reversed','switch']) for(const protection of [false,true])
test(`multi-value comparisons preserve effects: ${branch}, protected=${protection}`,()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-multi-comparisons-'));
  const previous=process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    const native=path.join(temporary,'native');fs.mkdirSync(native);
    const decision=branch==='switch'?`lookupswitch\n 0 : Lsecond\n default : Lcondition\nLsecond:`
      :`${branch==='reversed'?'ifeq':'ifne'} Lcondition`;
    const store=`aload_1\n iload 4\n iconst_1\n iload_3\n invokestatic Method Effects store ([IIII)V`;
    const file=path.join(native,'MultiComparisons.class');
    assembleJasminSource(`.version 49 0
.class public super MultiComparisons
.super java/lang/Object
.method public static fill : (I[III)V
.code stack 4 locals 5
 ${protection?'.catch java/lang/RuntimeException from Lstart to Lreturn using Lhandler':''}
Lstart: iconst_0\n istore 4\n iload 4\n iload_0
Lcondition: if_icmpge Lreturn
 ${store}
 iload_0\n iload 4\n iload_2\n ${decision}
 if_icmplt Lextra\n goto Lincrement
Lextra: ${store.replace('iconst_1','iconst_2')}
Lincrement: iinc 4 1\n iload 4\n iload_0\n goto Lcondition
Lreturn: return
 ${protection?'Lhandler: invokestatic Method Effects caught (Ljava/lang/Throwable;)V\n return':''}
.end code
.end method
.end class`,file);
    const effects=`class Effects {static StringBuilder trace;static int calls;
      static void store(int[] array,int index,int value,int throwAt) {
        trace.append(index).append(':').append(value).append(','); calls++;
        if(calls==throwAt)throw new IllegalArgumentException(); array[index]=value;
      }
      static void caught(Throwable error) {trace.append(error.getClass().getSimpleName());}
    }`;
    const driver=`import java.util.Arrays; class Runner {public static void main(String[] args) {
      for(int flag:new int[]{-1,0,1,42}) for(int n:new int[]{-1,0,1,2,4})
      for(int size:new int[]{-1,0,1,2,4}) for(int throwAt:new int[]{-1,0,1,2,3}) {
        int[] array=size<0?null:new int[size]; Effects.trace=new StringBuilder();Effects.calls=0;
        String result="ok";try {MultiComparisons.fill(n,array,flag,throwAt);}
        catch(Throwable error){result=error.getClass().getSimpleName();}
        System.out.println(result+":"+Arrays.toString(array)+":"+Effects.calls+":"+Effects.trace);
      }
    }}`;
    for(const [name,source] of Object.entries({Effects:effects,Runner:driver}))fs.writeFileSync(path.join(native,name+'.java'),source);
    run('javac',['--release','8','-cp',native,'-d',native,path.join(native,'Effects.java'),path.join(native,'Runner.java')],native);
    const expected=run('java',['-cp',native,'Runner'],native);
    assert.equal(expected.trim().split('\n').length,500);
    for(const forced of [false,true]) {
      if(forced)process.env.CFR_JS_FORCE_STATE_MACHINE='1';else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
      const source=decompileClassFile(file,{forceOwnedStructurer:true});assertNoFallback(source);
      assert.equal(source.includes('switch (statePc)'),forced);
      const rebuilt=path.join(temporary,forced?'forced':'structured');fs.mkdirSync(rebuilt);
      for(const [name,text] of Object.entries({MultiComparisons:source,Effects:effects,Runner:driver}))fs.writeFileSync(path.join(rebuilt,name+'.java'),text);
      run('javac',['--release','8','-d',rebuilt,...['MultiComparisons','Effects','Runner'].map(name=>path.join(rebuilt,name+'.java'))],rebuilt);
      assert.equal(run('java',['-cp',rebuilt,'Runner'],rebuilt),expected);
    }
  } finally {
    if(previous===undefined)delete process.env.CFR_JS_FORCE_STATE_MACHINE;else process.env.CFR_JS_FORCE_STATE_MACHINE=previous;
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});
