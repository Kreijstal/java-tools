'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {foldTrailingLoopContinuations: fold, foldLoopExitContinuations: foldExit, foldTerminalLoopExits: foldTerminal, foldNonlocalLoopExits: foldNonlocal, foldLoopElseExitGuards: foldElseExit} = require('../src/decompiler/javaAstEmitter');

test('leading nonlocal breaks become loop headers without changing their destination', () => {
  const source = 'Stop:{Next:while(true){if(stop()){break Stop;}step();if(again())continue Next;}finish();}after();';
  const result = foldNonlocal(source, {retainDiagnostics: true});
  assert.equal(result.loopsRecovered, 1);
  assert.match(result.source, /^Stop:\{Next: while \(!\(stop\(\)\)\) \{step\(\);if\(again\(\)\)continue Next;\s*\}\s*break Stop;finish\(\);\}after\(\);$/);
  assert.equal(result.diagnostics.exitTarget, 'Stop');
  assert.equal(source.slice(result.diagnostics.exitRange.start, result.diagnostics.exitRange.end), 'break Stop;');
  assert.equal(foldNonlocal(result.source).loopsRecovered, 0);
  const scalar = 'Stop:{if(pick)Next:while(true){if(stop()){break Stop;}step();}else other();}';
  const scalarResult = foldNonlocal(scalar, {parameterNames: ['pick'], retainDiagnostics: true});
  assert.equal(scalarResult.diagnostics.scalarParentWrapped, true);
  assert.match(scalarResult.source, /if\(pick\)\{\s*Next: while/);
  assert.match(scalarResult.source, /break Stop;\s*\}else other\(\);/);
});

test('nonlocal header recovery retains body declarations and complete protected transfers', () => {
  for (const body of [
    'int mark=step();use(mark);',
    'try{if(again())continue Next;}finally{cleanup();}',
    'try{step();}finally{if(again())continue Next;}',
    'synchronized(lock){if(again())continue Next;}',
    'Inner:while(more()){if(stop)break Inner;continue;}',
    'if(stop)break Stop;step();',
    'if(stop)continue Rounds;step();',
  ]) {
    const source = 'Rounds:for(;;){Stop:{Next:while(true){if(done()){break Stop;}' + body + '}finish();}}';
    const result = foldNonlocal(source, {parameterNames: ['stop', 'lock']});
    assert.equal(result.loopsRecovered, 1, source);
    assert.ok(result.source.includes(body), 'complete remaining body bytes');
  }
});

test('own exits, non-break entry transfers, constants and ambiguous syntax refuse nonlocal headers', () => {
  for (const source of [
    'Stop:{Next:while(true){if(done()){break Stop;}if(stop)break;step();}}',
    'Stop:{Next:while(true){if(done()){break Stop;}if(stop)break Next;step();}}',
    'Stop:{Next:while(true){if(done()){break Stop;}try{step();}finally{if(stop)break Next;}}}',
    'Next:while(true){if(done()){break Next;}step();}',
    'Stop:{while(true){if(done()){break;}step();}}',
    'Stop:{while(true){if(done()){return;}step();}}',
    'Stop:{while(true){if(done()){step();break Stop;}step();}}',
    'Stop:{while(true){if(done())break Stop;step();}}',
    'Stop:{while(true){if(done()){break Stop;}else step();step();}}',
    'Stop:{while(true){step();if(done()){break Stop;}step();}}',
    'Stop:{while(true){if(true){break Stop;}step();}}',
    'final boolean done=true;Stop:{while(true){if(done){break Stop;}step();}}',
    'Stop:{while(true){if(Holder.CONSTANT){break Stop;}step();}}',
    'Stop:{while(true){if(done()){break Missing;}step();}}',
    'Stop:{while(true){if(done()){break Stop;}1+2;}}',
    'Stop:{while(true){if(done()){break Stop;}step()}}',
    'Stop:{while(true){if(done()){break Stop;}step();}}Stop:{}',
    'Stop:{while(true){if(done()){break Stop;}step();}} // comment\n',
    'Stop:{while(true){if(done()){break Stop;}step();}}\\u000a',
  ]) assert.equal(foldNonlocal(source, {parameterNames: ['stop']}).source, source, source);
});

test('nonlocal header native traces match an independent guard/body/finally event model', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nonlocal-header-native-'));
  const run = (command, args) => {
    const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
    assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout;
  };
  try {
    const inner = 'step("B",mode,t);index++;if(mode==4)return done(index,polls,t);if(mode==5)break Stop;if(mode==6)continue Rounds;if(mode==8)throw SPECIFIC;if(flag==0)continue Next;step("T",mode,t);';
    const finalizer = 'step("F",mode,t);if(mode==7)return done(99,polls,t);if(mode==8&&index<3)continue Next;if(mode==9)break Rounds;';
    const bodies = [inner, 'try{' + inner + '}finally{' + finalizer + '}',
      'synchronized(lock){t.append(Thread.holdsLock(lock)?"L":"bad");' + inner + '}',
      'try{' + inner + '}catch(Specific failure){t.append("C");return done(70,polls,t);}',
      'try{synchronized(lock){t.append(Thread.holdsLock(lock)?"L":"bad");' + inner + '}}finally{' + finalizer + '}',
      'int mark=index;t.append(mark);' + inner];
    let methods = '';
    for (const [variant, body] of bodies.entries()) {
      const source = 'Rounds:for(int round=0;round<2;round++){Stop:{Next:while(true){if(++polls>limit||!gate){break Stop;}' + body + '}}step("S",mode,t);return done(index,polls,t);}return done(index,polls,t);';
      const result = foldNonlocal(source, {parameterNames: ['limit', 'gate', 'flag', 'mode', 'lock'], retainDiagnostics: true});
      assert.equal(result.loopsRecovered, 1, source);
      for (const [name, contents] of Object.entries({old: source, next: result.source}))
        methods += `static String ${name}${variant}(int limit,Boolean gate,int flag,int mode,Object lock){int index=0,polls=0;StringBuilder t=trace=new StringBuilder();${contents}}\n`;
    }
    const fixture = `public class NonlocalHeaders {
      static class Specific extends RuntimeException{}static final Specific SPECIFIC=new Specific();static final Error FATAL=new Error();static StringBuilder trace;
      static void step(String stage,int mode,StringBuilder t){t.append(stage);if(stage.equals("B")&&mode==1||stage.equals("T")&&mode==2||stage.equals("F")&&mode==3||stage.equals("S")&&mode==11)throw SPECIFIC;if(stage.equals("B")&&mode==10)throw FATAL;}
      static String done(int index,int polls,StringBuilder t){return index+":"+polls+":"+t;}
      ${methods}
      static String invoke(boolean next,int v,int limit,Boolean gate,int flag,int mode,Object lock){try{switch(v){${bodies.map((_,i) => `case ${i}:return next?next${i}(limit,gate,flag,mode,lock):old${i}(limit,gate,flag,mode,lock);`).join('')}}throw new AssertionError();}
        catch(Throwable failure){if(failure==SPECIFIC)return "error:S";if(failure==FATAL)return "error:E";if(failure instanceof NullPointerException)return "error:N";throw new AssertionError(failure);}}
      public static void main(String[]args){boolean next=args[0].equals("next");for(int v=0;v<6;v++)for(int limit:new int[]{-1,0,1,3})for(Boolean gate:new Boolean[]{null,false,true})for(int flag=-1;flag<=1;flag++)for(int mode=0;mode<12;mode++)for(int lockKind=0;lockKind<2;lockKind++){
        Object lock=lockKind==0?null:new Object();String result=invoke(next,v,limit,gate,flag,mode,lock);if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");
        System.out.println(v+","+limit+","+gate+","+flag+","+mode+","+lockKind+"|"+result+"|"+trace);}}
    }`;
    const file = path.join(temporary, 'NonlocalHeaders.java'); fs.writeFileSync(file, fixture);
    run('javac', ['--release', '8', '-d', temporary, file]);
    const original = run('java', ['-cp', temporary, 'NonlocalHeaders', 'old']);
    assert.equal(run('java', ['-cp', temporary, 'NonlocalHeaders', 'next']), original);
    const expected = [];
    for (let v=0;v<6;v++) for (const limit of [-1,0,1,3]) for (const gate of [null,false,true]) for (let flag=-1;flag<=1;flag++) for (let mode=0;mode<12;mode++) for (let lock=0;lock<2;lock++) {
      let index=0,polls=0,trace='',result;
      const done = n => n+':'+polls+':'+trace;
      for (let round=0;round<2 && result===undefined;round++) {
        let endRounds=false,nextRound=false;
        for (;;) {
          polls++;
          if (polls<=limit && gate===null) {result='error:N';break;}
          if (polls>limit || !gate) break;
          let failure,pending,exitStop=false,repeat=false;
          if (v===5) trace+=index;
          if ((v===2 || v===4) && !lock) failure='N';
          else {
            if (v===2 || v===4) trace+='L';trace+='B';
            if (mode===1) failure='S';else if(mode===10)failure='E';
            else {index++;if(mode===4)pending=done(index);else if(mode===5)exitStop=true;else if(mode===6)nextRound=true;else if(mode===8)failure='S';else if(flag===0)repeat=true;else {trace+='T';if(mode===2)failure='S';}}
          }
          if (v===3 && failure==='S') {trace+='C';failure=undefined;pending=done(70);}
          if (v===1 || v===4) {
            trace+='F';
            if (mode===3) {failure='S';pending=undefined;exitStop=false;nextRound=false;repeat=false;}
            else if(mode===7) {failure=undefined;pending=done(99);exitStop=false;nextRound=false;repeat=false;}
            else if(mode===8 && index<3) {failure=undefined;pending=undefined;exitStop=false;nextRound=false;repeat=true;}
            else if(mode===9) {failure=undefined;pending=undefined;exitStop=false;nextRound=false;repeat=false;endRounds=true;}
          }
          if(failure){result='error:'+failure;break;}
          if(pending!==undefined){result=pending;break;}
          if(exitStop || nextRound || endRounds)break;
          if(repeat)continue;
        }
        if(result!==undefined || endRounds)break;
        if(nextRound)continue;
        trace+='S';result=mode===11?'error:S':done(index);
      }
      if(result===undefined)result=done(index);
      expected.push(`${v},${limit},${gate},${flag},${mode},${lock}|${result}|${trace}`);
    }
    const actualRows = original.trim().split('\n');assert.equal(actualRows.length,expected.length);
    for(let index=0;index<expected.length;index++)assert.equal(actualRows[index],expected[index],'independent nonlocal-header case '+index);
    assert.equal(expected.length,5184);
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});

test('direct trailing backedges become ordered do-while guards at a fixed point', () => {
  const source = 'Next:while(true){step();if(first())continue Next;if(second()){continue;}finish();return;}';
  const result = fold(source, {retainDiagnostics: true});
  assert.equal(result.loopsRecovered, 1);
  assert.match(result.source, /^Next: do \{step\(\);\s*\} while \(\(first\(\)\) \|\| \(second\(\)\)\);\s*finish\(\);return;$/);
  assert.deepEqual(result.diagnostics.predicates, ['first()', 'second()']);
  assert.deepEqual(result.diagnostics.removedContinueRanges.map(({start, end}) => source.slice(start, end)), ['continue Next;', 'continue;']);
  assert.equal(fold(result.source).loopsRecovered, 0);
  const scalar = 'if(pick)Next:while(true){step();if(more())continue Next;return;}else other();';
  assert.match(fold(scalar, {parameterNames: ['pick']}).source, /if\(pick\)\{\s*Next: do/);
  assert.match(fold(scalar, {parameterNames: ['pick']}).source, /\}\s*else other\(\);/);
});

test('whole protected prefixes, nonlocal transfers and continuation scopes are retained', () => {
  for (const prefix of [
    'try{step();if(stop)return;}finally{cleanup();}',
    'try{step();}catch(RuntimeException error){recover();}',
    'synchronized(lock){step();}',
    'Inner:while(more()){if(stop)break Inner;continue;}',
    'if(stop)break Stop;',
  ]) {
    const source = 'Stop:{Next:while(true){' + prefix + 'if(again())continue Next;int mark=9;return;}}int mark=7;use(mark);';
    const result = fold(source, {parameterNames: ['stop', 'lock'], retainDiagnostics: true});
    assert.equal(result.loopsRecovered, 1, source);
    assert.ok(result.source.includes(prefix), 'complete protected/group prefix bytes');
    assert.equal(result.diagnostics.retainedTailScope, true);
    assert.match(result.source, /\{\s*int mark=9;return;\s*\}/);
  }
});

test('skipped tests, consumed breaks, local scopes, constants and ambiguous syntax refuse conversion', () => {
  const refused = [
    'while(true){if(stop)continue;step();if(more())continue;return;}',
    'Next:while(true){try{step();}finally{if(stop)continue Next;}if(more())continue Next;return;}',
    'Next:while(true){if(stop)break Next;step();if(more())continue Next;return;}',
    'while(true){if(stop)break;step();if(more())continue;return;}',
    'while(true){int count=step();if(count>0)continue;return;}',
    'while(true){step();if(more()){step();continue;}return;}',
    'while(true){step();if(more()){try{continue;}finally{cleanup();}}return;}',
    'while(true){step();if(more())continue;else step();return;}',
    'while(true){step();if(more())continue;step();}',
    'while(true){step();if(more())continue;}',
    'while(true){if(more())continue;return;}',
    'Next:while(true){step();if(more())continue Next;step();continue Next;}',
    'while(true){step();if(true)continue;return;}',
    'final boolean flag=true;while(true){step();if(flag)continue;return;}',
    'while(true){step();if(Holder.CONSTANT)continue;return;}',
    'Next:while(true){step();if(more())continue Missing;return;}',
    'Next:while(true){step();if(more())continue Next;return;}Next:{step();}',
    'while(true){step();if(more())continue;return;} // comment\n',
    'while(true){step();if(more())continue;return;}\\u000a',
    'while(true){step();if(more())continue;return;}class Local{}',
    'while(true){step();if(more())continue;return;}Runnable r=()->step();',
    'while(true){1+2;step();if(more())continue;return;}',
    'while(true){step() if(more())continue;return;}',
  ];
  for (const source of refused) assert.equal(fold(source, {parameterNames: ['stop']}).source, source, source);
  const source = 'while(true){step();if(more())continue;return;}';
  for (const options of [{parameterNames: ['pick', 'pick']}, {parameterNames: ['bad-name']}, {retainDiagnostics: 'yes'}])
    assert.deepEqual(fold(source, options), {source, loopsRecovered: 0});
});

test('exit continuations leave complete repeating prefixes intact, including effectful else arms', () => {
  const source = 'Next:while(true){if(first()){step();if(flag)continue Next;}else{other();}finish();return;}';
  const result = foldExit(source, {parameterNames: ['flag'], retainDiagnostics: true});
  assert.equal(result.continuationsRecovered, 1);
  assert.match(result.source, /^Next:while\(true\)\{if\(first\(\)\)\{step\(\);if\(flag\)continue Next;\}else\{other\(\);\}\s*break;\s*\}\s*finish\(\);return;$/);
  assert.equal(source.slice(result.diagnostics.prefixRange.start, result.diagnostics.prefixRange.end), 'if(first()){step();if(flag)continue Next;}else{other();}');
  assert.equal(source.slice(result.diagnostics.suffixRange.start, result.diagnostics.suffixRange.end), 'finish();return;');
  assert.equal(foldExit(result.source, {parameterNames: ['flag']}).continuationsRecovered, 0);
  const scalar = 'if(pick)Next:while(true){if(more())continue Next;finish();return;}else other();';
  assert.match(foldExit(scalar, {parameterNames: ['pick']}).source, /if\(pick\)\{\s*Next:while/);
  assert.match(foldExit(scalar, {parameterNames: ['pick']}).source, /\}\s*else other\(\);/);
});

test('exit continuations retain suffix scope and whole protected/nonlocal repeating paths', () => {
  for (const prefix of [
    'try{if(more())continue Next;}finally{cleanup();}',
    'try{step();}finally{if(more())continue Next;}',
    'synchronized(lock){if(more())continue Next;}',
    'try{if(more())continue Next;}catch(RuntimeException error){recover();}',
    'if(stop)break Stop;if(more())continue Next;',
    'if(more())while(true){continue Next;}',
  ]) {
    const source = 'Stop:{Next:while(true){' + prefix + 'int mark=9;return;}}int mark=7;use(mark);';
    const result = foldExit(source, {parameterNames: ['stop', 'lock'], retainDiagnostics: true});
    assert.equal(result.continuationsRecovered, 1, source);
    assert.ok(result.source.includes(prefix), 'complete prefix constructs stay intact');
    assert.equal(result.diagnostics.retainedTailScope, true);
    assert.match(result.source, /\{\s*int mark=9;return;\s*\}/);
  }
});

test('own exits, continuing/fallthrough tails, local scopes and ambiguity refuse hoisting', () => {
  for (const source of [
    'while(true){if(more())continue;if(stop)break;return;}',
    'Next:while(true){if(more())continue Next;try{return;}finally{if(stop)break Next;}}',
    'Next:while(true){try{if(more())continue Next;}finally{if(stop)break Next;}return;}',
    'while(true){int value=step();if(more())continue;return value;}',
    'while(true){if(more())continue;step();}',
    'while(true){if(more())continue;}',
    'while(true){continue;return;}',
    'while(true){step();return;}',
    'while(more()){if(stop)continue;return;}',
    'while(true){if(more())continue Missing;return;}',
    'Next:while(true){if(more())continue Next;return;}Next:{step();}',
    'while(true){if(more())continue;return;} // comment\n',
    'while(true){if(more())continue;return;}\\u000a',
    'while(true){if(more())continue;return;}class Local{}',
    'while(true){if(more())continue;return;}Runnable r=()->step();',
    'while(true){1+2;if(more())continue;return;}',
    'while(true){step() if(more())continue;return;}',
  ]) assert.equal(foldExit(source, {parameterNames: ['stop']}).source, source, source);
  const source = 'while(true){if(more())continue;return;}';
  for (const options of [{parameterNames: ['pick', 'pick']}, {parameterNames: ['bad-name']}, {retainDiagnostics: 'yes'}])
    assert.deepEqual(foldExit(source, options), {source, continuationsRecovered: 0});
});

test('terminal entry guards retain the true arm fallthrough exit and all earlier backedges', () => {
  const source = 'Next:while(true){if(more()){step();if(flag)continue Next;}break;}finish();';
  const result = foldTerminal(source, {parameterNames: ['flag'], retainDiagnostics: true});
  assert.equal(result.loopsRecovered, 1);
  assert.equal(result.diagnostics.form, 'while');
  assert.equal(result.diagnostics.retainedFallthroughBreak, true);
  assert.match(result.source, /Next: while \(more\(\)\) \{step\(\);if\(flag\)continue Next;\s*break;\s*\}finish\(\);/);
  assert.equal(foldTerminal(result.source, {parameterNames: ['flag']}).loopsRecovered, 0);
  const abrupt = foldTerminal('while(true){if(more()){try{continue;}finally{cleanup();}}break;}finish();', {retainDiagnostics: true});
  assert.equal(abrupt.loopsRecovered, 1);
  assert.equal(abrupt.diagnostics.retainedFallthroughBreak, false);
  assert.match(abrupt.source, /while \(more\(\)\) \{try\{continue;\}finally\{cleanup\(\);\}\}finish\(\);/);
  const scoped = foldTerminal('while(true){if(more()){int mark=1;use(mark);if(flag)continue;}break;}int mark=2;use(mark);', {parameterNames: ['flag']});
  assert.equal(scoped.loopsRecovered, 1);
  assert.match(scoped.source, /int mark=1;use\(mark\);if\(flag\)continue;\s*break;\s*\}int mark=2/);
});

test('terminal trailing guards consume only direct own continues and the final bare break', () => {
  const source = 'Next:while(true){step();if(first())continue Next;if(second()){continue;}break;}finish();';
  const result = foldTerminal(source, {retainDiagnostics: true});
  assert.equal(result.loopsRecovered, 1);
  assert.equal(result.diagnostics.form, 'doWhile');
  assert.equal(result.diagnostics.removedLoopLabel, 'Next');
  assert.deepEqual(result.diagnostics.predicates, ['first()', 'second()']);
  assert.match(result.source, /^do \{step\(\);\s*\} while \(\(first\(\)\) \|\| \(second\(\)\)\);finish\(\);/);
  assert.equal(foldTerminal(result.source).loopsRecovered, 0);
  const scalar = 'if(pick)while(true){step();if(more())continue;break;}else other();';
  assert.equal(foldTerminal(scalar, {parameterNames: ['pick']}).loopsRecovered, 1);
  assert.match(foldTerminal(scalar, {parameterNames: ['pick']}).source, /\}\s*else other\(\);/);
});

test('terminal exits refuse constant guards, earlier trailing backedges, scopes and ambiguous syntax', () => {
  for (const source of [
    'while(true){if(true){step();}break;}finish();',
    'final boolean more=true;while(true){if(more){step();}break;}finish();',
    'while(true){if(Holder.CONSTANT){step();}break;}finish();',
    'while(true){if(more()){step();}else other();break;}finish();',
    'Next:while(true){if(more()){step();}break Next;}finish();',
    'while(true){step();if(more())continue;step();break;}',
    'Next:while(true){if(stop)continue Next;step();if(more())continue Next;break;}',
    'Next:while(true){try{step();}finally{if(stop)continue Next;}if(more())continue Next;break;}',
    'while(true){int count=step();if(count>0)continue;break;}',
    'while(true){step();if(true)continue;break;}finish();',
    'while(true){step();if(more())continue Missing;break;}',
    'Next:while(true){if(more()){step();}break;}Next:{step();}',
    'while(true){if(more()){step();}break;} // comment\n',
    'while(true){if(more()){step();}break;}\\u000a',
    'while(true){if(more()){step();}break;}class Local{}',
    'while(true){if(more()){step();}break;}Runnable r=()->step();',
    'while(true){if(more()){1+2;}break;}',
    'while(true){if(more()){step() break;}break;}',
  ]) assert.equal(foldTerminal(source, {parameterNames: ['stop']}).source, source, source);
  const source = 'while(true){if(more()){step();}break;}';
  for (const options of [{parameterNames: ['pick', 'pick']}, {parameterNames: ['bad-name']}, {retainDiagnostics: 'yes'}])
    assert.deepEqual(foldTerminal(source, options), {source, loopsRecovered: 0});
});

test('terminal entry headers match independent native cases for partial arms and finally backedges', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-header-native-'));
  const run = (command, args) => {
    const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 24 * 1024 * 1024});
    assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout;
  };
  try {
    const inner = 'step("B",mode,t);index++;if(mode==4)return done(index,polls,t);if(mode==5)break Stop;if(mode==6)continue Rounds;if(mode==8)throw SPECIFIC;if(flag==0)continue Next;';
    const finalizer = 'step("F",mode,t);if(mode==7)return done(99,polls,t);if(mode==8&&index<3)continue Next;if(mode==9)break Rounds;';
    const arms = [inner, 'try{' + inner + '}finally{' + finalizer + '}',
      'synchronized(lock){t.append(Thread.holdsLock(lock)?"L":"bad");' + inner + '}',
      'try{' + inner + '}catch(Specific failure){t.append("C");return done(70,polls,t);}',
      'try{synchronized(lock){t.append(Thread.holdsLock(lock)?"L":"bad");' + inner + '}}finally{' + finalizer + '}',
      'int mark=index;t.append(mark);' + inner];
    let methods = '';
    for (const [variant, arm] of arms.entries()) {
      const source = 'Rounds:for(int round=0;round<2;round++){Stop:{Next:while(true){if(++polls<=limit&&gate){' + arm + '}break;}step("S",mode,t);return done(index,polls,t);}t.append("E");}return done(index,polls,t);';
      const result = foldTerminal(source, {parameterNames: ['limit', 'gate', 'flag', 'mode', 'lock'], retainDiagnostics: true});
      assert.equal(result.loopsRecovered, 1, source);
      assert.equal(result.diagnostics.form, 'while');
      assert.equal(result.diagnostics.retainedFallthroughBreak, true);
      for (const [name, body] of Object.entries({old: source, next: result.source}))
        methods += `static String ${name}${variant}(int limit,Boolean gate,int flag,int mode,Object lock){int index=0,polls=0;StringBuilder t=trace=new StringBuilder();${body}}\n`;
    }
    const fixture = `public class TerminalHeaders {
      static class Specific extends RuntimeException{}static final Specific SPECIFIC=new Specific();static final Error FATAL=new Error();static StringBuilder trace;
      static void step(String stage,int mode,StringBuilder t){t.append(stage);if(stage.equals("B")&&mode==1||stage.equals("S")&&mode==2||stage.equals("F")&&mode==3)throw SPECIFIC;if(stage.equals("B")&&mode==10)throw FATAL;}
      static String done(int index,int polls,StringBuilder t){return index+":"+polls+":"+t;}
      ${methods}
      static String invoke(boolean next,int v,int limit,Boolean gate,int flag,int mode,Object lock){try{switch(v){${arms.map((_,i) => `case ${i}:return next?next${i}(limit,gate,flag,mode,lock):old${i}(limit,gate,flag,mode,lock);`).join('')}}throw new AssertionError();}
        catch(Throwable failure){if(failure==SPECIFIC)return "error:S";if(failure==FATAL)return "error:E";if(failure instanceof NullPointerException)return "error:N";throw new AssertionError(failure);}}
      public static void main(String[]args){boolean next=args[0].equals("next");for(int v=0;v<6;v++)for(int limit=-5;limit<=25;limit++)for(Boolean gate:new Boolean[]{null,false,true})for(int flag=-1;flag<=1;flag++)for(int mode=0;mode<11;mode++)for(int lockKind=0;lockKind<2;lockKind++){
        Object lock=lockKind==0?null:new Object();String result=invoke(next,v,limit,gate,flag,mode,lock);if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");
        System.out.println(v+","+limit+","+gate+","+flag+","+mode+","+lockKind+"|"+result+"|"+trace);}}
    }`;
    const file = path.join(temporary, 'TerminalHeaders.java'); fs.writeFileSync(file, fixture);
    run('javac', ['--release', '8', '-d', temporary, file]);
    const original = run('java', ['-cp', temporary, 'TerminalHeaders', 'old']);
    assert.equal(run('java', ['-cp', temporary, 'TerminalHeaders', 'next']), original);
    const expected = [];
    for (let v=0;v<6;v++) for (let limit=-5;limit<=25;limit++) for (const gate of [null,false,true]) for (let flag=-1;flag<=1;flag++) for (let mode=0;mode<11;mode++) for (let lock=0;lock<2;lock++) {
      let index=0,polls=0,trace='',result;
      const done = n => n+':'+polls+':'+trace;
      for (let round=0;round<2 && result===undefined;round++) {
        let endRounds=false;
        for (;;) {
          polls++;
          if (polls<=limit && gate===null) {result='error:N';break;}
          if (polls>limit || !gate) {trace+='S';result=mode===2?'error:S':done(index);break;}
          let failure,pending,exitStop=false,nextRound=false,repeat=false;
          if (v===5) trace+=index;
          if ((v===2 || v===4) && !lock) failure='N';
          else {
            if (v===2 || v===4) trace+='L';trace+='B';
            if (mode===1) failure='S';else if(mode===10)failure='E';
            else {index++;if(mode===4)pending=done(index);else if(mode===5)exitStop=true;else if(mode===6)nextRound=true;else if(mode===8)failure='S';else if(flag===0)repeat=true;}
          }
          if (v===3 && failure==='S') {trace+='C';failure=undefined;pending=done(70);}
          if (v===1 || v===4) {
            trace+='F';
            if (mode===3) {failure='S';pending=undefined;exitStop=false;nextRound=false;repeat=false;}
            else if(mode===7) {failure=undefined;pending=done(99);exitStop=false;nextRound=false;repeat=false;}
            else if(mode===8 && index<3) {failure=undefined;pending=undefined;exitStop=false;nextRound=false;repeat=true;}
            else if(mode===9) {failure=undefined;pending=undefined;exitStop=false;nextRound=false;repeat=false;endRounds=true;}
          }
          if(failure){result='error:'+failure;break;}
          if(pending!==undefined){result=pending;break;}
          if(exitStop){trace+='E';break;}
          if(nextRound || endRounds)break;
          if(repeat)continue;
          trace+='S';result=mode===2?'error:S':done(index);break;
        }
        if(endRounds)break;
      }
      if(result===undefined)result=done(index);
      expected.push(`${v},${limit},${gate},${flag},${mode},${lock}|${result}|${trace}`);
    }
    const actualRows = original.trim().split('\n');assert.equal(actualRows.length,expected.length);
    for(let index=0;index<expected.length;index++)assert.equal(actualRows[index],expected[index],'independent partial-arm case '+index);
    assert.equal(expected.length,36828);
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});

for (const [name, recover, counter] of [
  ['trailing', fold, 'loopsRecovered'], ['exit continuation', foldExit, 'continuationsRecovered'],
  ['terminal do-while', (source, options) => foldTerminal(foldExit(source, options).source, options), 'loopsRecovered'],
]) test(name + ' native traces match an independent event oracle across protected and nullable guard paths', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'trailing-loop-native-'));
  const run = (command, args) => {
    const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
    assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout;
  };
  try {
    const inner = 'step("B",mode,t);index++;if(mode==7)return done(index,t);if(mode==8)break Stop;if(mode==9)continue Rounds;';
    const prefixes = [
      inner,
      'try{' + inner + '}finally{step("F",mode,t);if(mode==10)return done(99,t);if(mode==11)break Rounds;}',
      'synchronized(lock){t.append(Thread.holdsLock(lock)?"L":"bad");' + inner + '}',
      'try{' + inner + '}catch(Specific failure){t.append("C");return done(70,t);}',
      'try{synchronized(lock){t.append(Thread.holdsLock(lock)?"L":"bad");' + inner + '}}finally{step("F",mode,t);if(mode==10)return done(99,t);if(mode==11)break Rounds;}',
      '{int mark=index;t.append(mark);}' + inner,
    ];
    const exitForm = name === 'exit continuation';
    if (exitForm) prefixes.push('try{' + inner + 'if(mode==14)throw SPECIFIC;}finally{step("F",mode,t);if(mode==14&&index<3)continue Next;}',
      inner + 'if(mode==15&&index<3)continue Next;');
    const modes = exitForm ? 16 : 14;
    const guards = exitForm
      ? 'if(first(index,limit,gate,mode,t)){t.append("R");continue Next;}else{t.append("Z");}if(second(index,limit,extra,mode,t)){t.append("K");continue;}'
      : 'if(first(index,limit,gate,mode,t))continue Next;if(second(index,limit,extra,mode,t)){continue;}';
    let methods = '';
    for (const [variant, prefix] of prefixes.entries()) {
      const source = 'Rounds:for(int round=0;round<2;round++){Stop:{Next:while(true){' + prefix
        + guards + 'int mark=index;t.append(mark);step("S",mode,t);return done(index,t);}}t.append("E");}return done(index,t);';
      const result = recover(source, {parameterNames: ['limit', 'gate', 'extra', 'mode', 'lock']});
      assert.equal(result[counter], 1, source);
      for (const [name, body] of Object.entries({old: source, next: result.source}))
        methods += `static String ${name}${variant}(int limit,Boolean gate,Boolean extra,int mode,Object lock){int index=0;StringBuilder t=trace=new StringBuilder();${body}}\n`;
    }
    const fixture = `public class TrailingLoops {
      static class Specific extends RuntimeException{} static class General extends RuntimeException{}
      static final Specific SPECIFIC=new Specific();static final General GENERAL=new General();static final Error FATAL=new Error();static StringBuilder trace;
      static void step(String stage,int mode,StringBuilder t){t.append(stage);if(stage.equals("B")&&mode==1||stage.equals("F")&&mode==2||stage.equals("S")&&mode==3)throw SPECIFIC;if(stage.equals("B")&&mode==4)throw FATAL;}
      static Boolean first(int index,int limit,Boolean gate,int mode,StringBuilder t){t.append("A");if(mode==5)throw SPECIFIC;if(mode==6)return null;return index<limit?gate:false;}
      static Boolean second(int index,int limit,Boolean extra,int mode,StringBuilder t){t.append("D");if(mode==12)throw GENERAL;if(mode==13)return null;return index==limit?extra:false;}
      static String done(int index,StringBuilder t){return index+":"+t;}
      ${methods}
      static String invoke(boolean next,int v,int limit,Boolean gate,Boolean extra,int mode,Object lock){try{switch(v){${prefixes.map((_,i) => `case ${i}:return next?next${i}(limit,gate,extra,mode,lock):old${i}(limit,gate,extra,mode,lock);`).join('')}}throw new AssertionError();}
        catch(Throwable failure){if(failure==SPECIFIC)return "error:S";if(failure==GENERAL)return "error:G";if(failure==FATAL)return "error:E";if(failure instanceof NullPointerException)return "error:N";throw new AssertionError(failure);}}
      public static void main(String[]args){boolean next=args[0].equals("next");for(int v=0;v<${prefixes.length};v++)for(int limit=-2;limit<=5;limit++)for(Boolean gate:new Boolean[]{null,false,true})for(Boolean extra:new Boolean[]{null,false,true})for(int mode=0;mode<${modes};mode++)for(int lockKind=0;lockKind<2;lockKind++){
        Object lock=lockKind==0?null:new Object();String result=invoke(next,v,limit,gate,extra,mode,lock);if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");
        System.out.println(v+","+limit+","+gate+","+extra+","+mode+","+lockKind+"|"+result+"|"+trace);}}
    }`;
    const file = path.join(temporary, 'TrailingLoops.java'); fs.writeFileSync(file, fixture);
    run('javac', ['--release', '8', '-d', temporary, file]);
    const original = run('java', ['-cp', temporary, 'TrailingLoops', 'old']);
    assert.equal(run('java', ['-cp', temporary, 'TrailingLoops', 'next']), original);
    // Event model uses ordinary loops and explicit pending completion. It is
    // independent of the AST rewrite and preserves return snapshots/finally.
    const expected = [];
    for (let v=0;v<prefixes.length;v++) for (let limit=-2;limit<=5;limit++) for (const gate of [null,false,true]) for (const extra of [null,false,true]) for (let mode=0;mode<modes;mode++) for (let lock=0;lock<2;lock++) {
      let index=0, trace='', result;
      const done = n => n+':'+trace;
      for (let round=0;round<2 && result===undefined;round++) {
        let nextRound=false, endRounds=false;
        for (;;) {
          let failure, pending, exitStop=false, repeat=false;
          if (v===5) trace+=index;
          if ((v===2 || v===4) && !lock) failure='N';
          else {
            if (v===2 || v===4) trace+='L';
            trace+='B';
            if (mode===1) failure='S'; else if (mode===4) failure='E';
            else {index++;if(mode===7)pending=done(index);else if(mode===8)exitStop=true;else if(mode===9)nextRound=true;}
          }
          if (v===6 && mode===14) failure='S';
          if (v===7 && mode===15 && index<3) repeat=true;
          if (v===3 && failure==='S') {trace+='C';failure=undefined;pending=done(70);}
          if (v===1 || v===4 || v===6) {
            trace+='F';
            if (mode===2) {failure='S';pending=undefined;exitStop=false;nextRound=false;}
            else if (v!==6 && mode===10) {failure=undefined;pending=done(99);exitStop=false;nextRound=false;}
            else if (v!==6 && mode===11) {failure=undefined;pending=undefined;exitStop=false;nextRound=false;endRounds=true;}
            if (v===6 && mode===14 && index<3) {failure=undefined;pending=undefined;exitStop=false;nextRound=false;repeat=true;}
          }
          if (failure) {result='error:'+failure;break;}
          if (pending!==undefined) {result=pending;break;}
          if (exitStop) {trace+='E';break;}
          if (nextRound || endRounds) break;
          if (repeat) continue;
          trace+='A';
          if (mode===5) {result='error:S';break;}
          if (mode===6 || index<limit && gate===null) {result='error:N';break;}
          if (index<limit && gate) {if(exitForm)trace+='R';continue;}
          if (exitForm) trace+='Z';
          trace+='D';
          if (mode===12) {result='error:G';break;}
          if (mode===13 || index===limit && extra===null) {result='error:N';break;}
          if (index===limit && extra) {if(exitForm)trace+='K';continue;}
          trace+=index;trace+='S';result=mode===3?'error:S':done(index);break;
        }
        if (endRounds) break;
      }
      if (result===undefined) result=done(index);
      expected.push(`${v},${limit},${gate},${extra},${mode},${lock}|${result}|${trace}`);
    }
    const actualRows = original.trim().split('\n');
    assert.equal(actualRows.length, expected.length);
    for (let index=0;index<expected.length;index++) assert.equal(actualRows[index], expected[index], 'independent event case ' + index);
    assert.equal(expected.length, exitForm ? 18432 : 12096);
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});


test('terminal else effects become explicit in-loop exits without changing either exit reason', () => {
  const source='Stop:{Next:while(true){if(poll()){step();if(again())continue Next;}else{finish();}break;}after();}';
  const result=foldElseExit(source,{retainDiagnostics:true});
  assert.equal(result.loopsRecovered,1);
  assert.match(result.source,/Next:while\(true\)\{\s*if \(!\(poll\(\)\)\) \{finish\(\);\s*break;\s*\}\s*step\(\);if\(again\(\)\)continue Next;\s*break;/);
  assert.equal(result.diagnostics.label,'Next');
  assert.equal(source.slice(result.diagnostics.armRange.start,result.diagnostics.armRange.end),'step();if(again())continue Next;');
  assert.equal(foldElseExit(result.source).loopsRecovered,0);
  for(const body of [
    'try{step();if(again())continue Next;}finally{if(stop)break Next;}',
    'try{step();if(stop)return;}finally{if(again())continue Next;}',
    'synchronized(lock){step();if(stop)break Stop;}',
    'Inner:for(int slot=0;slot<2;slot++){if(stop)break Inner;}step();',
  ]) {
    const original='Stop:{if(pick)Next:while(true){if(poll()){'+body+'}else{finish();}break;}else other();}';
    const next=foldElseExit(original,{parameterNames:['stop','lock','pick']});
    assert.equal(next.loopsRecovered,1,original);
    assert.ok(next.source.includes(body),'intact protected/inner-control construct');
    assert.match(next.source,/\}else other\(\);\}/,'scalar parent retains its original else');
  }
});

test('exit guard recovery refuses declarations, changed frame order and unreachable new exits', () => {
  for(const source of [
    'while(true){if(poll()){int slot=step();use(slot);}else{finish();}break;}',
    'while(true){if(poll()){step();}else{int slot=step();use(slot);}break;}',
    'while(true){if(poll()){step();}else{Exit:{finish();}}break;}',
    'while(true){if(poll()){step();}else{while(again()){finish();}}break;}',
    'while(true){if(poll()){step();}else{try{finish();}finally{cleanup();}}break;}',
    'while(true){if(poll()){return;}else{finish();}break;}',
    'while(true){if(poll()){step();}else{return;}break;}',
    'while(true){if(poll()){step();}else{finish();}return;}',
    'Next:while(true){if(poll()){step();}else{finish();}break Next;}',
    'while(true){prefix();if(poll()){step();}else{finish();}break;}',
    'while(true){if(poll())step();else{finish();}break;}',
    'while(true){if(poll()){step();}else finish();break;}',
    'while(true){if(poll()){continue Missing;}else{finish();}break;}',
    'while(true){if(poll()){step()}else{finish();}break;}',
    'while(true){if(poll()){step();}else{finish();}break;} // comment\n',
    'while(true){if(poll()){step();}else{finish();}break;}\\u000a',
  ])assert.equal(foldElseExit(source).source,source,source);
});

test('loop exit guards match an independent native event model including finally overrides and monitors', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'loop-else-exit-native-'));
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:16*1024*1024});assert.equal(result.status,0,result.stderr||result.stdout);return result.stdout;};
  try {
    const inner='step("B",mode,t);index++;if(mode==4)return done(index,polls,t);if(mode==5)break Stop;if(mode==6)continue Rounds;if(mode==8)throw SPECIFIC;if(flag==0)continue Next;step("T",mode,t);';
    const finalizer='step("F",mode,t);if(mode==7)return done(99,polls,t);if(mode==8&&index<3)continue Next;if(mode==9)break Next;';
    const bodies=[inner,'try{'+inner+'}finally{'+finalizer+'}',
      'synchronized(lock){t.append(Thread.holdsLock(lock)?"L":"bad");'+inner+'}',
      'try{'+inner+'}catch(Specific failure){t.append("C");return done(70,polls,t);}',
      'try{synchronized(lock){t.append(Thread.holdsLock(lock)?"L":"bad");'+inner+'}}finally{'+finalizer+'}',
      'Inner:for(int scan=0;scan<1;scan++){t.append("I");if(mode>=0)break Inner;}'+inner];
    let methods='';
    for(const [variant,body] of bodies.entries()){
      const source='Rounds:for(int round=0;round<2;round++){Stop:{Next:while(true){if(++polls<=limit&&gate){'+body+'}else{step("X",mode,t);}break;}}step("S",mode,t);return done(index,polls,t);}return done(index,polls,t);';
      const result=foldElseExit(source,{parameterNames:['limit','gate','flag','mode','lock'],retainDiagnostics:true});
      assert.equal(result.loopsRecovered,1,source);
      for(const [name,contents]of Object.entries({old:source,next:result.source}))
        methods+='static String '+name+variant+'(int limit,Boolean gate,int flag,int mode,Object lock){int index=0,polls=0;StringBuilder t=trace=new StringBuilder();'+contents+'}\n';
    }
    const fixture='public class LoopElseExits {\n'+
      'static class Specific extends RuntimeException{}static final Specific SPECIFIC=new Specific();static final Error FATAL=new Error();static StringBuilder trace;\n'+
      'static void step(String stage,int mode,StringBuilder t){t.append(stage);if(stage.equals("B")&&mode==1||stage.equals("T")&&mode==2||stage.equals("F")&&mode==3||stage.equals("X")&&mode==11)throw SPECIFIC;if(stage.equals("B")&&mode==10)throw FATAL;}\n'+
      'static String done(int index,int polls,StringBuilder t){return index+":"+polls+":"+t;}\n'+methods+
      'static String invoke(boolean next,int v,int limit,Boolean gate,int flag,int mode,Object lock){try{switch(v){'+bodies.map((_,i)=>'case '+i+':return next?next'+i+'(limit,gate,flag,mode,lock):old'+i+'(limit,gate,flag,mode,lock);').join('')+'}throw new AssertionError();}catch(Throwable failure){if(failure==SPECIFIC)return "error:S";if(failure==FATAL)return "error:E";if(failure instanceof NullPointerException)return "error:N";throw new AssertionError(failure);}}\n'+
      'public static void main(String[]args){boolean next=args[0].equals("next");for(int v=0;v<6;v++)for(int limit:new int[]{-1,0,1,3})for(Boolean gate:new Boolean[]{null,false,true})for(int flag=-1;flag<=1;flag++)for(int mode=0;mode<12;mode++)for(int lockKind=0;lockKind<2;lockKind++){Object lock=lockKind==0?null:new Object();String result=invoke(next,v,limit,gate,flag,mode,lock);if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");System.out.println(v+","+limit+","+gate+","+flag+","+mode+","+lockKind+"|"+result+"|"+trace);}}\n}';
    const file=path.join(temporary,'LoopElseExits.java');fs.writeFileSync(file,fixture);run('javac',['--release','8','-d',temporary,file]);
    const original=run('java',['-cp',temporary,'LoopElseExits','old']);
    assert.equal(run('java',['-cp',temporary,'LoopElseExits','next']),original);
    const expected=[];
    for(let v=0;v<6;v++)for(const limit of [-1,0,1,3])for(const gate of [null,false,true])for(let flag=-1;flag<=1;flag++)for(let mode=0;mode<12;mode++)for(let lock=0;lock<2;lock++){
      let index=0,polls=0,trace='',result;const done=n=>n+':'+polls+':'+trace;
      for(let round=0;round<2&&result===undefined;round++){
        let nextRound=false;
        for(;;){
          polls++;
          if(polls<=limit&&gate===null){result='error:N';break;}
          if(polls>limit||!gate){trace+='X';if(mode===11)result='error:S';break;}
          let failure,pending,exitStop=false,repeat=false,exitLoop=false;
          if(v===5)trace+='I';
          if((v===2||v===4)&&!lock)failure='N';
          else{if(v===2||v===4)trace+='L';trace+='B';
            if(mode===1)failure='S';else if(mode===10)failure='E';
            else{index++;if(mode===4)pending=done(index);else if(mode===5)exitStop=true;else if(mode===6)nextRound=true;else if(mode===8)failure='S';else if(flag===0)repeat=true;else{trace+='T';if(mode===2)failure='S';}}}
          if(v===3&&failure==='S'){trace+='C';failure=undefined;pending=done(70);}
          if(v===1||v===4){trace+='F';
            if(mode===3){failure='S';pending=undefined;exitStop=false;nextRound=false;repeat=false;}
            else if(mode===7){pending=done(99);failure=undefined;exitStop=false;nextRound=false;repeat=false;}
            else if(mode===8&&index<3){failure=undefined;pending=undefined;exitStop=false;nextRound=false;repeat=true;}
            else if(mode===9){failure=undefined;pending=undefined;exitStop=false;nextRound=false;repeat=false;exitLoop=true;}}
          if(failure){result='error:'+failure;break;}if(pending!==undefined){result=pending;break;}
          if(exitStop||nextRound||exitLoop)break;if(repeat)continue;break;
        }
        if(result!==undefined||nextRound)continue;trace+='S';result=done(index);
      }
      if(result===undefined)result=done(index);
      expected.push([v,limit,String(gate),flag,mode,lock].join(',')+'|'+result+'|'+trace);
    }
    assert.equal(original,expected.join('\n')+'\n','all5184 native cases match independent guard/body/false-arm/finally/monitor event model');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
