'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {foldGuardedFrameCompletion: fold} = require('../src/decompiler/javaAstEmitter');
const options = {dominatingAssignments: true, retainDiagnostics: true};

test('prior bound assignments enable guarded remainders without moving their effects', () => {
  for (const source of [
    'int x;x=read();Frame:{if(stop())break Frame;use(x);}',
    'Object x;x=read();effect();if(enter()){Frame:{if(stop())break Frame;use(x);}}',
    'int x;x=read();Outer:while(next()){Frame:{if(stop())break Frame;use(x);}tail();}',
    'int x;try{x=read();Frame:{if(stop())break Frame;use(x);}}finally{cleanup();}',
    'int x;synchronized(lock){x=read();Frame:{if(stop())break Frame;use(x);}}',
  ]) {
    assert.equal(fold(source).source, source, 'default contract stays unchanged');
    const result = fold(source, options);
    assert.equal(result.framesRecovered, 1, source);
    assert.equal(result.diagnostics.dominatingAssignments.length, 1);
    assert.equal(result.diagnostics.prefixAssignments.length, 0);
    assert.equal(result.source.split('x=read()').length - 1, 1);
    assert.equal(result.source.split('use(x)').length - 1, 1);
    let expected = source;
    for (const edit of result.diagnostics.edits) expected = expected.slice(0, edit.start) + edit.text + expected.slice(edit.end);
    assert.equal(result.source, expected);
    assert.equal(fold(result.source, options).framesRecovered, 0);
  }
});

test('conditional, shadowed, protected-entry and self-reading assignments refuse', () => {
  for (const source of [
    'int x;if(enter())x=read();Frame:{if(stop())break Frame;use(x);}',
    'int x;while(next())x=read();Frame:{if(stop())break Frame;use(x);}',
    'int x;try{x=read();}catch(Exception e){}Frame:{if(stop())break Frame;use(x);}',
    'int x;x=read();try{Frame:{if(stop())break Frame;use(x);}}finally{cleanup();}',
    'int x;try{x=read();}catch(Exception e){Frame:{if(stop())break Frame;use(x);}}',
    'int x;x=read();switch(kind){case 1:Frame:{if(stop())break Frame;use(x);}}',
    '{int x;x=read();}int x;Frame:{if(stop())break Frame;use(x);}',
    'int x;x=read(x);Frame:{if(stop())break Frame;use(x);}',
    'int x;x+=read();Frame:{if(stop())break Frame;use(x);}',
    'int x;Frame:{if(stop())break Frame;use(x);}x=read();',
  ]) assert.equal(fold(source, options).source, source, source);
  const source = 'int x;x=read();Frame:{if(stop())break Frame;use(x);}';
  assert.equal(fold(source, {...options, reservedNames: ['x']}).source, source);
  assert.equal(fold(source, {...options, dominatingAssignments: 1}).source, source);
});

test('existing prefix evidence and fresh decision names remain stable', () => {
  const source = 'int x;x=earlier();Frame:{x=later();if(stop())break Frame;use(x);}';
  const old = fold(source, {retainDiagnostics: true});
  const next = fold(source, options);
  assert.equal(next.source, old.source);
  assert.deepEqual(next.diagnostics.prefixAssignments, old.diagnostics.prefixAssignments);
  assert.deepEqual(next.diagnostics.dominatingAssignments, []);
  const named = fold('int x;x=read();Frame:{if(stop())break Frame;use(x);}',
    {...options, reservedNames: ['decompiledFrameRemainder0']});
  assert.equal(named.diagnostics.name, 'decompiledFrameRemainder1');
});

test('native prior assignments preserve snapshots, partial failures and protected completions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dominating-frame-native-'));
  const run = (command, args) => {
    const outputs = ['out', 'err'].map(name => path.join(directory, name));
    const descriptors = outputs.map(file => fs.openSync(file, 'w'));
    try {
      const result = spawnSync(command, args, {stdio: ['ignore', ...descriptors]});
      if (result.error) throw result.error;
      assert.equal(result.status, 0, fs.readFileSync(outputs[1], 'utf8'));
      return fs.readFileSync(outputs[0], 'utf8').trim();
    } finally { descriptors.forEach(fd => fs.closeSync(fd)); }
  };
  const wrappers = [
    s => s,
    s => `try{${s}}finally{event(9);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,
    s => `synchronized(lock){${s}}`,
    s => `try{${s}}catch(IllegalStateException e){event(10);if(e!=FAILURE)throw e;}finally{event(9);}`,
  ];
  try {
    let methods = '';
    for (let model = 0; model < wrappers.length; model++) {
      const before = wrappers[model](`int captured;Object retained;int control;captured=prepare(seed);retained=state;control=flag;if(choice(outer,0)){Frame:{event(1);state=SECOND;if(choice(stop,2))break Frame;event(3);value+=captured;originalAlias=retained==INITIAL;if(control!=0){event(4);value=value*17-captured;currentAlias=retained==state;}}}event(5);`) + 'return snapshot();';
      const next = fold(before, options);
      assert.equal(next.framesRecovered, 1);
      assert.equal(next.diagnostics.dominatingAssignments.length, 3);
      // The work oracle leaves its own helper early; it does not duplicate the
      // compiler's flag/suffix algorithm. Preparation uses independent arithmetic.
      const oracle = wrappers[model]('value+=13;event(7);int saved=(int)((long)seed*31L+7L);Object savedObject=state;int savedFlag=flag;if(oracleChoice(outer,0))oracleWork(stop,saved,savedObject,savedFlag);event(5);') + 'return snapshot();';
      for (const [name, source] of [['old', before], ['next', next.source], ['oracle', oracle]]) {
        methods += `static String ${name}${model}(Boolean outer,Boolean stop,int seed,int flag,int mode){${source}}\n`;
      }
    }
    const java = `public class DominatingOracle{
      static int value,count,failAt;static boolean originalAlias,currentAlias;static Object state,lock;
      static StringBuilder trace;static final Object INITIAL=new Object(),SECOND=new Object();
      static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();
      static void event(int n){trace.append(n).append(Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}
      static int prepare(int seed){value+=13;event(7);return seed*31+7;}
      static boolean choice(Boolean x,int n){event(n);return x.booleanValue();}
      static boolean oracleChoice(Boolean x,int n){event(n);if(x==null)throw new NullPointerException();return x==Boolean.TRUE;}
      static void oracleWork(Boolean stop,int saved,Object savedObject,int savedFlag){event(1);state=SECOND;if(oracleChoice(stop,2))return;event(3);value+=saved;originalAlias=savedObject==INITIAL;if(savedFlag!=0){event(4);value=value*17-saved;currentAlias=savedObject==state;}}
      static String snapshot(){return value+":"+count+":"+originalAlias+":"+currentAlias+":"+trace;}
      ${methods}
      static String take(int model,int variant,Boolean outer,Boolean stop,int seed,int flag,int mode){value=seed;count=0;originalAlias=false;currentAlias=false;state=INITIAL;lock=new Object();trace=new StringBuilder();String result;try{switch(model){${wrappers.map((_, i) => `case ${i}:result=variant==0?old${i}(outer,stop,seed,flag,mode):variant==1?next${i}(outer,stop,seed,flag,mode):oracle${i}(outer,stop,seed,flag,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("lock leaked");return result+":"+snapshot();}
      public static void main(String[]args){int cases=0;for(int model=0;model<${wrappers.length};model++)for(Boolean outer:new Boolean[]{false,true,null})for(Boolean stop:new Boolean[]{false,true,null})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int flag:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int mode=0;mode<3;mode++)for(int failure=-1;failure<12;failure++){failAt=failure;String expected=take(model,2,outer,stop,seed,flag,mode);for(int variant=0;variant<2;variant++){String actual=take(model,variant,outer,stop,seed,flag,mode);if(!expected.equals(actual))throw new AssertionError(model+":"+outer+":"+stop+":"+seed+":"+flag+":"+mode+":"+failure+":"+expected+":"+actual);}cases++;}System.out.println(cases);}}
    `;
    const file = path.join(directory, 'DominatingOracle.java');
    fs.writeFileSync(file, java);
    run('javac', ['--release', '8', '-d', directory, file]);
    assert.equal(run('java', ['-Xmx128m', '-cp', directory, 'DominatingOracle']), '35100');
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
