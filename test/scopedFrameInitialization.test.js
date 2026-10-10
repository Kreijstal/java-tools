'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {JavaParser} = require('../src/java-frontend/parser');
const {independentlyAssignedLocalSequence: assigned} = require('../src/decompiler/primitiveLocalLifetimeRecovery');
const {foldGuardedFrameCompletion: guard, foldLoopFrameCompletion: loop} = require('../src/decompiler/javaAstEmitter');
const options = {scopedInitialization: true, retainDiagnostics: true, effectfulGuards: true};

test('branch-local initialization proves the selected remainder without initializing other arms', () => {
  for (const source of [
    'int x;Frame:{if(enter()){x=read();if(stop())break Frame;use(x);}}',
    'Object x;Frame:{if(enter()){x=read();if(stop()){mark();break Frame;}use(x);}}',
    'int x;try{Frame:{if(enter()){x=read();if(stop())break Frame;use(x);}}}finally{cleanup();}',
  ]) {
    assert.equal(guard(source, {effectfulGuards: true}).source, source);
    const result = guard(source, options);
    assert.equal(result.framesRecovered, 1, source);
    assert.equal(result.diagnostics.priorAssignments.length, 1);
    assert.equal(result.source.split('x=read()').length - 1, 1);
    assert.equal(result.source.split('use(x)').length - 1, 1);
    let expected = source;
    for (const edit of result.diagnostics.edits) expected = expected.slice(0, edit.start) + edit.text + expected.slice(edit.end);
    assert.equal(result.source, expected);
  }
});

test('loop completion retains prior branch snapshots and refuses unsafe reaching assignments', () => {
  const source = 'int x;Object retained;retained=state;Frame:{if(active()){x=read();while(next()){work();if(stop())break Frame;}use(x,retained);}}';
  assert.equal(loop(source).source, source);
  const result = loop(source, options);
  assert.equal(result.exitsRecovered, 1);
  assert.equal(result.labelsRemoved, 1);
  assert.equal(result.diagnostics.priorAssignments.length, 2);
  for (const action of ['retained=state', 'x=read()', 'work()', 'stop()', 'use(x,retained)']) assert.equal(result.source.split(action).length - 1, 1);
  for (const source of [
    'int x;Frame:{if(enter())x=read();while(next()){if(stop())break Frame;}use(x);}',
    'int x;Frame:{while(next()){if(stop())break Frame;x=read();}use(x);}',
    'int x;try{x=read();}catch(Exception e){Frame:{while(next()){if(stop())break Frame;}use(x);}}',
    'int x;Frame:{if(enter()){x=read();while(next()){try{if(stop())break Frame;}finally{cleanup();}}use(x);}}',
    '{int x;x=read();}int x;Frame:{while(next()){if(stop())break Frame;}use(x);}',
  ]) assert.equal(loop(source, options).source, source, source);
  assert.equal(loop(source, {scopedInitialization: 1}).source, source);
  assert.equal(guard('Frame:{if(stop())break Frame;work();}', {scopedInitialization: 1}).framesRecovered, 0);
});

test('post-test assignment flow agrees with javac on break, continue and later reads', () => {
  const parser = new JavaParser();
  const cases = [
    ['do {if(early())break;x=read();}while(use(x));after();', true],
    ['do {if(early())break;x=read();}while(use(x));after(x);', false],
    ['do {x=read();if(early())continue;}while(use(x));after(x);', true],
    ['do {if(early())continue;x=read();}while(use(x));after(x);', false],
    ['Outer:do {x=read();if(early())continue Outer;}while(use(x));after(x);', true],
    ['do {x=read();if(early())break;x=read();}while(use(x));after(x);', true],
    ['do {if(early())return;x=read();}while(use(x));after(x);', true],
  ];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'post-test-flow-javac-'));
  try {
    for (let index = 0; index < cases.length; index++) {
      const [source, expected] = cases[index];
      const statements = parser.parseStatement('{'+source+'}', {requireComplete: true}).statements;
      assert.equal(assigned(statements, 'x'), false, 'default post-test refusal stays unchanged');
      assert.equal(assigned(statements, 'x', [], {postTestLoops: true}), expected, source);
      const file = path.join(directory, 'Case'+index+'.java');
      fs.writeFileSync(file, `class Case${index}{static boolean early(){return false;}static int read(){return 7;}static boolean use(int x){return false;}static void after(){}static void after(int x){}static void run(){int x;${source}}}`);
      const outputs = ['out', 'err'].map(n => path.join(directory, n)), descriptors = outputs.map(f => fs.openSync(f, 'w'));
      try {
        const result = spawnSync('javac', ['--release', '8', '-d', directory, file], {stdio: ['ignore', ...descriptors]});
        if (result.error) throw result.error;
        assert.equal(result.status === 0, expected, source + ': ' + fs.readFileSync(outputs[1], 'utf8'));
        if (!expected) assert.match(fs.readFileSync(outputs[1], 'utf8'), /might not have been initialized/);
      } finally { descriptors.forEach(fd => fs.closeSync(fd)); }
    }
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('native branch, loop-completion and post-test work match independent early-return oracles', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-frame-native-'));
  const run = (command, args) => {
    const outputs = ['out', 'err'].map(n => path.join(directory, n)), descriptors = outputs.map(f => fs.openSync(f, 'w'));
    try {
      const result = spawnSync(command, args, {stdio: ['ignore', ...descriptors]});
      if (result.error) throw result.error;
      assert.equal(result.status, 0, fs.readFileSync(outputs[1], 'utf8'));
      return fs.readFileSync(outputs[0], 'utf8').trim();
    } finally { descriptors.forEach(fd => fs.closeSync(fd)); }
  };
  const wrappers = [s=>s, s=>`try{${s}}finally{event(9);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,
    s=>`synchronized(lock){${s}}`, s=>`try{${s}}catch(IllegalStateException e){event(10);if(e!=FAILURE)throw e;}finally{event(9);}`];
  const bodies = [
    'int captured;Object retained;Frame:{if(choice(outer,0)){captured=prepare(seed);retained=state;event(1);state=SECOND;if(choice(stop,2))break Frame;event(3);value+=captured;alias=retained==INITIAL;if(flag!=0){event(4);value=value*17-captured;}}}event(5);',
    'int captured;Object retained;retained=state;Frame:{if(choice(outer,0)){captured=prepare(seed);for(int i=0;test(i);i=update(i)){event(1);state=SECOND;if(choice(stop,2))break Frame;event(4);value+=i+flag;}event(6);value+=captured;alias=retained==INITIAL;}}event(5);',
    'int captured;Frame:{if(choice(outer,0))break Frame;do{event(1);state=SECOND;if(choice(stop,2))break;captured=prepare(seed);event(4);value+=captured+flag;}while(postTest(captured));}event(5);',
  ];
  const oracles = [
    'if(oracleChoice(outer,0)){value+=13;event(7);int saved=(int)((long)seed*31L+7L);Object savedObject=state;oracleBranch(stop,saved,savedObject,flag);}event(5);',
    'Object savedObject=state;if(oracleChoice(outer,0)){value+=13;event(7);int saved=(int)((long)seed*31L+7L);oracleLoop(stop,saved,savedObject,flag);}event(5);',
    'if(!oracleChoice(outer,0))oraclePostTest(stop,seed,flag);event(5);',
  ];
  try {
    let methods = '', models = 0;
    for (let kind = 0; kind < bodies.length; kind++) for (const wrap of wrappers) {
      const before = wrap(bodies[kind])+'return snapshot();';
      const next = (kind===1?loop:guard)(before, options);
      assert.equal(kind===1?next.exitsRecovered:next.framesRecovered, 1, before);
      const oracle = wrap(oracles[kind])+'return snapshot();';
      for (const [name, source] of [['old', before], ['next', next.source], ['oracle', oracle]]) methods+=`static String ${name}${models}(Boolean outer,Boolean stop,int seed,int flag,int mode){${source}}\n`;
      models++;
    }
    const java = `public class ScopedOracle{
      static int value,count,failAt,round;static boolean alias;static Object state,lock;static StringBuilder trace;
      static final Object INITIAL=new Object(),SECOND=new Object();static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();
      static void event(int n){trace.append(n).append(Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}
      static int prepare(int seed){value+=13;event(7);return seed*31+7;}
      static boolean choice(Boolean b,int n){event(n);return b.booleanValue();}
      static boolean oracleChoice(Boolean b,int n){event(n);if(b==null)throw new NullPointerException();return b==Boolean.TRUE;}
      static boolean test(int i){event(3);return i<3;}static int update(int i){event(8);return i+1;}
      static boolean postTest(int captured){event(3);value^=captured;return round++<2;}
      static void oracleBranch(Boolean stop,int saved,Object savedObject,int flag){event(1);state=SECOND;if(oracleChoice(stop,2))return;event(3);value+=saved;alias=savedObject==INITIAL;if(flag!=0){event(4);value=value*17-saved;}}
      static void oracleLoop(Boolean stop,int saved,Object savedObject,int flag){int i=0;while(true){event(3);if(i>=3)break;event(1);state=SECOND;if(oracleChoice(stop,2))return;event(4);value+=i+flag;event(8);i++;}event(6);value+=saved;alias=savedObject==INITIAL;}
      static void oraclePostTest(Boolean stop,int seed,int flag){while(true){event(1);state=SECOND;if(oracleChoice(stop,2))return;value+=13;event(7);int saved=(int)((long)seed*31L+7L);event(4);value+=saved+flag;event(3);value^=saved;int old=round;round++;if(old>=2)return;}}
      static String snapshot(){return value+":"+count+":"+round+":"+alias+":"+(state==INITIAL)+":"+trace;}
      ${methods}
      static String take(int model,int variant,Boolean outer,Boolean stop,int seed,int flag,int mode){value=seed;count=0;round=0;alias=false;state=INITIAL;lock=new Object();trace=new StringBuilder();String result;try{switch(model){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(outer,stop,seed,flag,mode):variant==1?next${i}(outer,stop,seed,flag,mode):oracle${i}(outer,stop,seed,flag,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("lock leaked");return result+":"+snapshot();}
      public static void main(String[]args){int cases=0;for(int model=0;model<${models};model++)for(Boolean outer:new Boolean[]{false,true,null})for(Boolean stop:new Boolean[]{false,true,null})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int flag:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int mode=0;mode<3;mode++)for(int failure=-1;failure<24;failure++){failAt=failure;String expected=take(model,2,outer,stop,seed,flag,mode);for(int variant=0;variant<2;variant++){String actual=take(model,variant,outer,stop,seed,flag,mode);if(!actual.equals(expected))throw new AssertionError(model+":"+outer+":"+stop+":"+seed+":"+flag+":"+mode+":"+failure+":"+expected+":"+actual);}cases++;}System.out.println(cases);}}
    `;
    const file=path.join(directory,'ScopedOracle.java');fs.writeFileSync(file,java);
    run('javac',['--release','8','-d',directory,file]);
    assert.equal(run('java',['-Xmx128m','-cp',directory,'ScopedOracle']),'202500');
  } finally { fs.rmSync(directory, {recursive:true,force:true}); }
});
