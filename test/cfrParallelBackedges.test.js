'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');
const {decompileClassFile, assertNoFallback, _internals: {resolveStackCarrierAliases, compactBlankSourceLines, rewriteStackCarrierReferences, rewriteWhileLoopsAsFor}} = require('../src/decompiler/cfr');

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


test('join aliases reach a fixed point without accepting incomplete edges or cycles',()=>{
  const name = index => `stackIn_${index}_0`;
  const initial = new Map([[name(2),name(1)],[name(3),name(1)],[name(6),name(1)]]);
  const state = (sources,edges=2,invalid=false) => ({sources:new Set(sources.map(name)),edges,invalid});
  const incoming = new Map([[name(7),state([5,6])],[name(5),state([2,3])]]);
  const preds=[];preds[5]=[2,3];preds[7]=[5,6];
  const types=new Map([1,2,3,5,6,7].map(index=>[name(index),'String']));
  const resolved=resolveStackCarrierAliases(initial,incoming,preds,types);
  for(const index of [2,3,5,6,7]) assert.equal(resolved.get(name(index)),name(1));
  assert.equal(initial.size,3);assert.equal(incoming.get(name(7)).sources.size,2);
  for(const bad of [state([2,3],1),state([2,3],3),state([2,3],2,true),state([2,4]),state([2,5])]) {
    const result=resolveStackCarrierAliases(initial,new Map([[name(5),bad]]),preds,types);
    assert.equal(result.has(name(5)),false);
  }
  const different=new Map(types);different.set(name(5),'Object');
  assert.equal(resolveStackCarrierAliases(initial,incoming,preds,different).has(name(5)),false);
  const cycle=new Map([[name(2),name(3)],[name(3),name(2)],[name(6),name(2)]]);
  assert.equal(resolveStackCarrierAliases(cycle,incoming,preds,types).size,0);
  const self=new Map([[name(2),name(2)],[name(3),name(2)]]);
  assert.equal(resolveStackCarrierAliases(self,incoming,preds,types).size,0);
});

test('blank carrier lines compact without changing comments, literals or Unicode translation',()=>{
  const source='first();\n  \n\n  second("a\\nb");\n\n  third();';
  assert.equal(compactBlankSourceLines(source),'first();\n  second("a\\nb");\n  third();');
  for(const body of [
    'first(); /* comment\n\nend */ second();',
    'first(); // comment\n\nsecond();',
    'String text="""\n\nkeep this\n\n""";',
    'first(); /* \\u000a */\n\nsecond();',
    'String text="unterminated;\n\n',
  ]) assert.equal(compactBlankSourceLines(body),body);
});

for(const protection of [false,true]) test(`typed multi-level joins preserve snapshots, identity and failures: protected=${protection}`,()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-typed-join-'));
  const previous=process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    const native=path.join(temporary,'native');fs.mkdirSync(native);
    const file=path.join(native,'TypedJoin.class');
    assembleJasminSource(`.version 49 0
.class public super TypedJoin
.super java/lang/Object
.method public static compute : (Ljava/lang/String;IIZ)Ljava/lang/String;
.code stack 5 locals 4
 ${protection?'.catch java/lang/RuntimeException from Lstart to Lend using Lhandler':''}
Lstart: aload_0\n iload_1\n iload_2\n ifne Lfirst
 ldc "changed-zero"\n astore_0\n iinc 1 10\n iconst_4\n goto Ljoin
Lfirst: ldc "changed-one"\n astore_0\n iinc 1 -10\n iconst_5
Ljoin: ldc "stackIn_3_0"\n invokestatic Method Effects mark (Ljava/lang/String;)V\n iload_3\n ifne Lsecond
 bipush 6\n goto Lfinish
Lsecond: bipush 7
Lfinish: invokestatic Method Effects finish (Ljava/lang/String;III)Ljava/lang/String;
Lend: areturn
 ${protection?'Lhandler: invokestatic Method Effects caught (Ljava/lang/Throwable;)Ljava/lang/String;\n areturn':''}
.end code
.end method
.end class`,file);
    const effects=`class Effects {static String expected; static int mode;static StringBuilder trace;
      static final RuntimeException failure=new IllegalArgumentException();
      static void mark(String value){trace.append(value).append('|');}
      static String finish(String value,int original,int first,int second) {
        if(value!=expected)throw new AssertionError("reference identity changed");
        trace.append(original).append(':').append(first).append(':').append(second);
        if(mode==1)throw failure;if(mode==2)return value.substring(0,1);return value;
      }
      static String caught(Throwable error){trace.append("caught:").append(error==failure);return "caught";}
    }`;
    const driver=`class Runner {public static void main(String[] args) {
      for(String input:new String[]{null,new String(""),new String("same"),new String("different")})
      for(int original:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})
      for(int first:new int[]{-1,0,1})for(boolean second:new boolean[]{false,true})for(int mode=0;mode<3;mode++) {
        Effects.expected=input;Effects.mode=mode;Effects.trace=new StringBuilder();String result="ok";String value=null;
        try{value=TypedJoin.compute(input,original,first,second);}catch(Throwable error){result=error.getClass().getName()+":"+(error==Effects.failure);}
        System.out.println(result+":"+value+":"+(value==input)+":"+Effects.trace);
      }
    }}`;
    for(const [name,source] of Object.entries({Effects:effects,Runner:driver}))fs.writeFileSync(path.join(native,name+'.java'),source);
    run('javac',['--release','8','-cp',native,'-d',native,path.join(native,'Effects.java'),path.join(native,'Runner.java')],native);
    const expected=run('java',['-cp',native,'Runner'],native);assert.equal(expected.trim().split('\n').length,360);
    for(const forced of [false,true]) {
      if(forced)process.env.CFR_JS_FORCE_STATE_MACHINE='1';else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
      const source=decompileClassFile(file,{forceOwnedStructurer:true});assertNoFallback(source);
      assert.equal(source.includes('switch (statePc)'),forced);
      if(!forced) {
        const stringCarriers=source.match(/String stackIn_\d+_\d+/g)||[];
        assert.equal(stringCarriers.length,protection?2:1,source);
        assert.doesNotMatch(source,/stackIn_\d+_\d+ = \(String\) \(\(Object\) stackIn_/);
      }
      const rebuilt=path.join(temporary,forced?'forced':'structured');fs.mkdirSync(rebuilt);
      for(const [name,text] of Object.entries({TypedJoin:source,Effects:effects,Runner:driver}))fs.writeFileSync(path.join(rebuilt,name+'.java'),text);
      run('javac',['--release','8','-d',rebuilt,...['TypedJoin','Effects','Runner'].map(name=>path.join(rebuilt,name+'.java'))],rebuilt);
      assert.equal(run('java',['-cp',rebuilt,'Runner'],rebuilt),expected);
    }
  } finally {
    if(previous===undefined)delete process.env.CFR_JS_FORCE_STATE_MACHINE;else process.env.CFR_JS_FORCE_STATE_MACHINE=previous;
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});


test('carrier substitution preserves literal, comment, member and method namespaces',()=>{
  const aliases=new Map([['stackIn_3_0','stackIn_2_0']]);
  const source=`stackIn_3_0 = stackIn_1_0;
trace.append("stackIn_3_0"); // stackIn_3_0
/* stackIn_3_0 */ Owner.stackIn_3_0 = stackIn_3_0;
stackIn_3_0(); use(Owner.stackIn_3_0, stackIn_3_0);`;
  const result=rewriteStackCarrierReferences(source,aliases);assert.equal(result.applied,true);
  assert.equal(result.source,`stackIn_2_0 = stackIn_1_0;
trace.append("stackIn_3_0"); // stackIn_3_0
/* stackIn_3_0 */ Owner.stackIn_3_0 = stackIn_2_0;
stackIn_3_0(); use(Owner.stackIn_3_0, stackIn_2_0);`);
  for(const body of [
    '{Object stackIn_3_0=null; use(stackIn_3_0);}',
    'try {fail();} catch(Exception stackIn_3_0){use(stackIn_3_0);}',
    'use((stackIn_3_0)value);', 'use(new stackIn_3_0());',
    'stackIn_3_0: {use(stackIn_3_0);break stackIn_3_0;}',
    'use(stackIn_3_0); // \\u000a', 'use(stackIn_3_0); @ syntax',
    'use(Owner::stackIn_3_0);',
  ]) assert.deepEqual(rewriteStackCarrierReferences(body,aliases),{source:body,applied:false},body);
  const text='use("""\nstackIn_3_0\n\n""",stackIn_3_0);';
  assert.deepEqual(rewriteStackCarrierReferences(text,aliases),{source:text,applied:false});
  assert.deepEqual(rewriteStackCarrierReferences(source,new Map([['other','stackIn_2_0']])),{source,applied:false});
  const generic='Owner.<RuntimeException>accept(stackIn_3_0);';
  assert.deepEqual(rewriteStackCarrierReferences(generic,aliases),
    {source:'Owner.<RuntimeException>accept(stackIn_2_0);',applied:true});
  for (const body of ['Owner.<stackIn_3_0>accept(value);',
    'Owner.<java.util.List<stackIn_3_0>>accept(value);',
    'Owner.<String + Other>accept(stackIn_3_0);'])
    assert.deepEqual(rewriteStackCarrierReferences(body,aliases),{source:body,applied:false});
});

test('qualified generic calls allow loop recovery without changing failure identity or counter updates',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'generic-loop-recovery-'));
  try {
    const body=`index = 0;
Loop: while (index < limit) {
  trace.append(index).append(':');
  if (index == failAt) {
    throw Fixture.<RuntimeException>fail(failure);
  }
  if (mode == 1 && index == 1) {
    index++;
    continue Loop;
  }
  if (mode == 2 && index == 2) {
    break Loop;
  }
  index++;
}`;
    const rebuilt=rewriteWhileLoopsAsFor(body.split('\n')).join('\n');
    assert.match(rebuilt,/Loop: for \(index = 0; index < limit; index\+\+\)/);
    assert.match(rebuilt,/Fixture\.<RuntimeException>fail\(failure\)/);
    const method=(name,code)=>`static String ${name}(int limit,int failAt,int mode) {
      int index=-99;StringBuilder trace=new StringBuilder();
      try {${code}} catch(Throwable error){trace.append("caught:").append(error==failure);}
      finally {trace.append("finally:").append(index);}
      return trace.toString();
    }`;
    const source=`class Fixture {
      static final Exception failure=new Exception("stackIn_3_0");
      @SuppressWarnings("unchecked") static <T extends Throwable> RuntimeException fail(Throwable error) throws T {throw (T)error;}
      ${method('original',body)} ${method('rebuilt',rebuilt)}
      public static void main(String[] args) {
        for(int limit:new int[]{-1,0,1,2,5})for(int failAt:new int[]{-1,0,1,2,3,4,5,6})for(int mode=0;mode<3;mode++) {
          String expected=original(limit,failAt,mode),actual=rebuilt(limit,failAt,mode);
          if(!expected.equals(actual))throw new AssertionError(expected+" != "+actual);
          System.out.println(actual);
        }
      }
    }`;
    fs.writeFileSync(path.join(temporary,'Fixture.java'),source);
    run('javac',['--release','8','-d',temporary,path.join(temporary,'Fixture.java')],temporary);
    assert.equal(run('java',['-cp',temporary,'Fixture'],temporary).trim().split('\n').length,120);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});
