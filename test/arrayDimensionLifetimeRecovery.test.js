'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {JavaParser} = require('../src/java-frontend/parser');
const {
  splitArrayDimensionPrimitiveLocalLifetimes: split,
  splitPrimitiveLocalLifetimes,
  splitInitializedPrimitiveLocalLifetimes,
  independentlyAssignedLocalSequence,
} = require('../src/decompiler/primitiveLocalLifetimeRecovery');

test('array dimensions expose independent primitive roles without changing existing modes', () => {
  const source = 'int x=0;x=first();Object a=new int[x][x=second()][];use(x);x=third();Object b=new String[x];use(x);';
  const result = split(source, {retainDiagnostics: true});
  assert.equal(result.localsSplit, 1);
  assert.ok(result.declarationsAdded >= 1);
  assert.equal(result.diagnostics.locals[0].type, 'int');
  assert.equal(splitPrimitiveLocalLifetimes(source).source, source);
  assert.equal(splitInitializedPrimitiveLocalLifetimes(source, {arrayDimensionLocals:true}).source, source);
  assert.equal(independentlyAssignedLocalSequence(new JavaParser().parseStatement('{x=first();Object a=new int[x];}').statements, 'x'), false);
  assert.equal(split('int x=0;use(x);x=first();use(x);').source, 'int x=0;use(x);x=first();use(x);');
});

test('array reads require assignment and preserve loop carries, handlers, captures and initializers', () => {
  for (const source of [
    'int x;Object a=new int[x];x=first();Object b=new int[x];',
    'int x=0;while(next()){Object a=new int[x];x=first();Object b=new int[x];}',
    'int x=0;try{x=first();Object a=new int[x];x=second();Object b=new int[x];}finally{use(x);}',
    'int x=0;try{x=first();Object a=new int[x];x=second();Object b=new int[x];}catch(RuntimeException e){use(x);}',
    'int x=0;x=first();Object a=new int[]{x};x=second();Object b=new int[x];',
    'int x=0;x=first();Object a=new int[x];Runnable r=()->use(x);x=second();Object b=new int[x];',
    'int x=0;x=first();Object a=new int[x];use(this.x);x=second();Object b=new int[x];',
  ]) assert.equal(split(source).source, source, source);
  const source = 'int x=0;try{x=first();Object a=new int[x];x=second();Object b=new int[x];}finally{finish();}';
  assert.ok(split(source).localsSplit);
  const signed = 'short x=0;x=(short)first();Object a=new int[x];x=(short)second();Object b=new int[x];';
  assert.equal(split(signed).diagnostics, undefined);
  assert.match(split(signed).source, /short xLifetime1;/);
});

test('native dimension order, negative sizes, partial effects, cleanup and monitors match independent oracles', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'array-dimension-native-'));
  const run = (command, args) => {
    const out = path.join(directory, 'out'), err = path.join(directory, 'err');
    const fds = [out, err].map(file => fs.openSync(file, 'w'));
    try {
      const result = spawnSync(command, args, {stdio:['ignore', ...fds]});
      if (result.error) throw result.error;
      assert.equal(result.status, 0, fs.readFileSync(err, 'utf8'));
      return fs.readFileSync(out, 'utf8').trim();
    } finally {fds.forEach(fd => fs.closeSync(fd));}
  };
  const patterns = [
    ['x=dimension(seed,0);int[][] a=new int[x][x=dimension(seed,1)];event(a.length);event(x);x=dimension(seed,2);Object[] b=new String[x];event(b.length);event(x);',
     'int first=dimension(seed,0),second=dimension(seed,1);int[][] a=new int[first][second];event(a.length);event(second);int third=dimension(seed,2);Object[] b=new String[third];event(b.length);event(third);'],
    ['x=dimension(seed,0);int[] a=new int[x];event(a.length);x=dimension(seed,1);int[][][] b=new int[x][dimension(seed,2)][];event(b.length);event(x);',
     'int first=dimension(seed,0);int[] a=new int[first];event(a.length);int second=dimension(seed,1);int[][][] b=new int[second][dimension(seed,2)][];event(b.length);event(second);'],
    ['event(x);int[][] a=new int[x=dimension(seed,0)][dimension(x,1)];event(a.length);event(x);x=dimension(seed,2);int[] b=new int[x];event(b.length);event(x);',
     'event(0);int first=dimension(seed,0);int[][] a=new int[first][dimension(first,1)];event(a.length);event(first);int third=dimension(seed,2);int[] b=new int[third];event(b.length);event(third);'],
    ['x=dimension(seed,0);int[] a=new int[x];event(a.length);x=dimension(seed,1);int[] b=new int[x=dimension(x,2)];event(b.length);event(x);',
     'int first=dimension(seed,0);int[] a=new int[first];event(a.length);int second=dimension(seed,1);int third=dimension(second,2);int[] b=new int[third];event(b.length);event(third);'],
  ];
  const protects = [s=>s, s=>`try{${s}}finally{event(991);if(mode==1)throw OVERRIDE;}`,
    s=>`synchronized(lock){${s}}`, s=>`try{${s}}catch(IllegalStateException e){event(992);if(e!=FAILURE)throw e;}finally{event(991);}`];
  try {
    let methods = '';
    for (let p=0;p<patterns.length;p++) for (let c=0;c<protects.length;c++) {
      const source = 'int x=0;'+protects[c](patterns[p][0])+'return snapshot();';
      const result = split(source);
      assert.ok(result.localsSplit, `pattern ${p}, context ${c}`);
      for (const [name,body] of [['old',source],['next',result.source],['oracle',protects[c](patterns[p][1])+'return snapshot();']])
        methods += `static String ${name}${p}_${c}(int seed,int mode){${body}}\n`;
    }
    const cases = patterns.flatMap((_,p)=>protects.map((_,c)=>`case ${p*protects.length+c}:result=variant==0?old${p}_${c}(seed,mode):variant==1?next${p}_${c}(seed,mode):oracle${p}_${c}(seed,mode);break;`)).join('');
    const java = `public class ArrayPhases {
      static long state;static int count,failAt;static Object lock;
      static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();
      static void event(long v){state=state*31+v;state=state*31+(Thread.holdsLock(lock)?1:0);if(count++==failAt)throw FAILURE;}
      static int dimension(int seed,int stage){event(seed);event(stage);return (seed+stage)%4;}
      static String snapshot(){return state+":"+count;}
      ${methods}
      static String take(int kind,int variant,int seed,int mode){state=count=0;lock=new Object();String result;try{switch(kind){${cases}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("monitor retained");return result+":"+snapshot();}
      public static void main(String[] args){int cases=0;for(int kind=0;kind<16;kind++)for(int seed:new int[]{Integer.MIN_VALUE,-7,-1,0,1,2,7,Integer.MAX_VALUE})for(int mode=0;mode<2;mode++)for(int failure=-1;failure<11;failure++){failAt=failure;String expected=take(kind,2,seed,mode);for(int variant=0;variant<2;variant++)if(!expected.equals(take(kind,variant,seed,mode)))throw new AssertionError(kind+":"+variant+":"+seed+":"+failure+":"+expected);cases++;}System.out.println(cases);}
    }`;
    const file=path.join(directory,'ArrayPhases.java');fs.writeFileSync(file,java);
    run('javac',['--release','8','-d',directory,file]);
    assert.equal(run('java',['-Xmx128m','-cp',directory,'ArrayPhases']), '3072');
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
